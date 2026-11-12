import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ServerInstanceConfig } from '../../types.js';
import { serverRootFor, resolveInsideRoot, PathOutsideRootError } from '../../protocol/paths.js';
import { allocatePort } from '../../protocol/ports.js';
import { placeholderScript, platformFor } from '../../platform/index.js';
import { containerInstallPlan, installPlanFor } from '../../install/manager.js';
import { buildDockerInstance, EggContainerError } from '../../docker/egg-container.js';
import { getAccess, setOwner } from '../../store/access.js';
import { initialValue, isUserVariable, validateVariables } from '../../eggs/rules.js';
import { loadEggs } from '../../eggs/loader.js';
import type { ApiContext } from './api-context.js';

/**
 * Server anlegen: Docker (Container aus dem Egg), Installationen und Platzhalter-Start.
 */
export function registerServerCreateRoutes(ctx: ApiContext): void {
  const { server, driver, bus, registry, account, installs, policy, eggInstallData, eggPorts, portRangeNow } = ctx;

  // Server anlegen (POST /api/v1/servers)
  server.post<{
    Body: {
      name: string;
      eggId: string;
      ramMb?: number;
      cpuPercent?: number;
      diskMb?: number;
      variables?: Record<string, string>;
      imageKey?: string;
    };
  }>('/api/v1/servers', async (req, reply) => {
    const { name, eggId, ramMb, cpuPercent, variables, imageKey } = req.body;
    if (!name || !eggId) {
      return reply.status(400).send({ error: 'Name und Game sind erforderlich.' });
    }

    // Grenzen des Benutzers (Anzahl Server, Arbeitsspeicher) - Verwalter sind ausgenommen
    const creator = req.actor!;
    if (!creator.master && creator.role !== 'admin') {
      const limits = account?.get(creator.id);
      const mine = registry.list().filter((c) => getAccess(registry, c.id).ownerId === creator.id);
      if (limits && limits.serverLimit > 0 && mine.length >= limits.serverLimit) {
        return reply.status(403).send({ error: `Server-Limit erreicht (${limits.serverLimit}).`, code: 'limit_reached' });
      }
      const ramUsed = mine.reduce((sum, c) => sum + (c.maxMemoryMb ?? 2048), 0);
      if (limits && limits.ramLimitMb > 0 && ramUsed + (ramMb ?? 2048) > limits.ramLimitMb) {
        return reply.status(403).send({ error: `Arbeitsspeicher-Limit erreicht (${limits.ramLimitMb} MB).`, code: 'limit_reached' });
      }
    }

    // Generiere saubere ID
    const cleanId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `server-${Date.now().toString(36)}`;

    const id = registry.get(cleanId) ? `${cleanId}-${Date.now().toString(36).slice(-4)}` : cleanId;
    let serverDir: string;
    try {
      serverDir = await resolveInsideRoot(serverRootFor(registry.dir), id, 'id');
    } catch (err) {
      if (err instanceof PathOutsideRootError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    await fs.mkdir(serverDir, { recursive: true });

    // Freien Port im konfigurierten Bereich suchen (Block A5)
    let port: number;
    try {
      port = await allocatePort(registry.list(), undefined, portRangeNow());
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }

    // Benutzer ohne Verwalterrolle: nur bekannte Spiele, nur die Variablen, die das Spiel vorsieht - und gueltig.
    // Sonst liesse sich ueber frei gewaehlte Werte (Umgebung, Startoptionen) Einfluss auf den Rechner nehmen.
    const adminLike = creator.master || creator.role === 'admin';
    const knownEgg = (await loadEggs()).find((e) => e.id === eggId);
    let givenVariables: Record<string, unknown> | undefined = variables;
    if (!adminLike) {
      if (!knownEgg) return reply.status(403).send({ error: 'Dieses Spiel gibt es nicht.', code: 'forbidden' });
      const defs = knownEgg.raw.variables ?? [];
      const allowed = new Set(defs.filter(isUserVariable).map((d) => d.env_variable));
      const picked = Object.fromEntries(
        Object.entries(variables ?? {})
          .filter(([key, value]) => allowed.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
          .map(([key, value]) => [key, String(value)]),
      );
      const start = Object.fromEntries(defs.map((d) => [d.env_variable, initialValue(d)]));
      const checked = validateVariables(defs, { ...start, ...picked });
      if (checked.errors.length > 0) {
        return reply.status(400).send({ error: 'Ungültige Werte', message: 'Ungültige Werte', code: 'invalid_variables', issues: checked.errors });
      }
      givenVariables = checked.values;
    }

    // Block B2: echte Installation statt Attrappe, wenn der Core dieses Egg kann.
    const installData = await eggInstallData(eggId, givenVariables);
    const egg = knownEgg;
    // Docker installiert ueber Installer-Container (siehe unten), nicht ueber die Windows-Wege
    const plan = installs && driver.name !== 'docker' ? installPlanFor(eggId, egg?.raw, installData.variables) : null;
    if (!adminLike && !plan && !policy.userFileWrite) {
      // Ohne Installation bliebe nur eine Platzhalter-Startdatei - die legt auf diesem Rechner nur ein Verwalter an
      return reply.status(403).send({ error: 'Dieses Spiel kann der Core für Benutzer noch nicht installieren.', code: 'forbidden' });
    }
    if (installs && plan) {
      // Steam-Spiele brauchen mehr als einen Port (Spiel, Abfrage ...): jeden aus dem Bereich des Cores
      let ports: ServerInstanceConfig['ports'] = [{ name: 'game', hostPort: port, protocol: 'tcp' }];
      if (plan.kind === 'steamcmd' || plan.kind === 'download') {
        try {
          ports = await eggPorts(egg?.raw.ports, port);
        } catch (err) {
          return reply.status(409).send({ error: (err as Error).message });
        }
      }
      const installing: ServerInstanceConfig = {
        id,
        name,
        game: eggId,
        executable: '',
        args: [],
        workingDir: serverDir,
        maxMemoryMb: ramMb ?? 2048,
        maxCpuPercent: cpuPercent ?? 100,
        ports,
        install: { state: 'installing', kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...installData },
      };
      await registry.add(installing);
      if (!creator.master) setOwner(registry, id, creator.id);
      registry.audit('server.create', id, 'standalone', { name, game: eggId, port, install: plan.kind });
      const task = installs.start(id, { kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...installData });
      return reply.status(201).send({ server: { id, shortId: id.slice(0, 8) }, taskId: task.id });
    }

    // Docker-Treiber: das Spiel läuft als Container aus dem Image des Eggs (wie im Panel)
    if (driver.name === 'docker') {
      if (!egg) return reply.status(404).send({ error: 'Dieses Spiel gibt es nicht.', code: 'not_found' });
      let instance: ServerInstanceConfig;
      try {
        const ports = await eggPorts(egg.raw.ports, port);
        instance = buildDockerInstance({ id, name, egg, serverDir, ramMb: ramMb ?? egg.resources.base_ram_mb ?? 2048, cpuPercent: cpuPercent ?? egg.resources.min_cpu_percent ?? 100, variables: installData.variables, ports, imageKey });
      } catch (err) {
        if (err instanceof EggContainerError) return reply.status(400).send({ error: err.message, code: 'invalid_image' });
        return reply.status(409).send({ error: (err as Error).message });
      }
      // Mit Installationsskript: erst der Installer-Container, danach meldet sich die Instanz beim Treiber an
      const containerPlan = installs ? containerInstallPlan(egg.raw) : null;
      if (installs && containerPlan) {
        await registry.add({ ...instance, install: { state: 'installing', kind: 'container', ...installData } });
        if (!creator.master) setOwner(registry, id, creator.id);
        registry.audit('server.create', id, 'standalone', { name, game: eggId, port, image: instance.container?.image, install: 'container' });
        const task = installs.start(id, { kind: 'container', ...installData });
        return reply.status(201).send({ server: { id, shortId: id.slice(0, 8) }, taskId: task.id });
      }
      await driver.registerServer(instance);
      await registry.add(instance);
      if (!creator.master) setOwner(registry, id, creator.id);
      registry.audit('server.create', id, 'standalone', { name, game: eggId, port, image: instance.container?.image });
      bus.emit({ type: 'state', serverId: id, state: { id, status: 'offline' }, ts: new Date().toISOString() });
      return reply.status(201).send({ server: { id, shortId: id.slice(0, 8) } });
    }

    // Erstelle Standardausführung oder Script
    const here = platformFor();
    const scriptPath = path.join(serverDir, here.scriptName);

    if (!existsSync(scriptPath)) {
      await fs.writeFile(scriptPath, placeholderScript(here, name, eggId, port), { mode: 0o755 });
    }

    const serverConfig: ServerInstanceConfig = {
      id,
      name,
      game: eggId,
      executable: scriptPath,
      args: [],
      workingDir: serverDir,
      maxMemoryMb: ramMb ?? 2048,
      maxCpuPercent: cpuPercent ?? 100,
      ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }],
      // Frei gewaehlte Umgebungsvariablen (PATH, JAVA_TOOL_OPTIONS ...) nur vom Verwalter
      env: adminLike ? ((variables as Record<string, string> | undefined) ?? {}) : {},
    };

    await driver.registerServer(serverConfig);
    await registry.add(serverConfig);
    if (!creator.master) setOwner(registry, id, creator.id);
    registry.audit('server.create', id, 'standalone', { name, game: eggId, port });

    bus.emit({
      type: 'state',
      serverId: id,
      state: { id, status: 'offline' },
      ts: new Date().toISOString(),
    });

    return reply.status(201).send({
      server: {
        id,
        shortId: id.slice(0, 8),
      },
    });
  });
}
