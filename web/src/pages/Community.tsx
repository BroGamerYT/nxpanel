import { useState } from 'react';
import { Link } from 'react-router';
import {
  ExternalLink,
  Code2,
  MessageSquare,
  BookOpen,
  Key,
  Users,
  Server,
  Heart,
  Bug,
  Tag,
  Coffee,
  Tv,
  Sparkles,
  FileText,
  ArrowRight,
  Shield,
  Layers,
  HelpCircle,
  Cpu,
  Globe,
} from 'lucide-react';
import { SteamAccounts } from '../components/SteamAccounts';
import { t } from '../lib/i18n';

export function Community() {
  const [tab, setTab] = useState<'hub' | 'steam'>('hub');

  const officialLinks = [
    {
      title: 'GitHub Repository',
      url: 'https://github.com/BroGamerYT/nxpanel',
      icon: Code2,
      color: 'text-amber',
      bgColor: 'bg-amber/10 border-amber/30',
      badge: 'BroGamerYT/nxpanel',
      description: 'Offizieller Quellcode, Commits, Versionierung und branches des gesamten NexusPanel-Systems.',
      external: true,
    },
    {
      title: 'Fehler & Wünsche (Issues)',
      url: 'https://github.com/BroGamerYT/nxpanel/issues',
      icon: Bug,
      color: 'text-rose-400',
      bgColor: 'bg-rose-500/10 border-rose-500/30',
      badge: 'GitHub Issues',
      description: 'Fehlerberichte einreichen, Funktionswünsche vorschlagen und an der Roadmap mitwirken.',
      external: true,
    },
    {
      title: 'Releases & Changelog',
      url: 'https://github.com/BroGamerYT/nxpanel/releases',
      icon: Tag,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/30',
      badge: 'Versionen & Tags',
      description: 'Neueste Veröffentlichungen, Build-Pakete und ausführliche Update-Notizen.',
      external: true,
    },
    {
      title: 'Dokumentation & Handbuch',
      url: '/hilfe',
      icon: FileText,
      color: 'text-sky-400',
      bgColor: 'bg-sky-500/10 border-sky-500/30',
      badge: 'Integrierte Doku',
      description: 'Vollständige Markdown-Bibliothek mit Architektur, Egg-Vorlagen, REST-API und Anleitungen.',
      external: false,
    },
  ];

  const communityLinks = [
    {
      title: 'Discord & Community-Support',
      url: 'https://discord.gg/germanylangame',
      icon: MessageSquare,
      color: 'text-[#5865F2]',
      bgColor: 'bg-[#5865F2]/10 border-[#5865F2]/30',
      badge: 'Germany LanGame',
      description: 'Direkter Austausch mit anderen Server-Admins, Gaming-Talk, Fragen und schneller Support.',
      external: true,
    },
    {
      title: 'Twitch Livestreams (DerBroGamerYT)',
      url: 'https://www.twitch.tv/derbrogameryt',
      icon: Tv,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10 border-purple-500/30',
      badge: 'Live auf Twitch',
      description: 'Live-Coding, Gameplay, Spieletests und Community-Events direkt auf Twitch verfolgen.',
      external: true,
    },
    {
      title: 'Germany LanGame Community',
      url: 'https://discord.gg/germanylangame',
      icon: Server,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10 border-cyan-500/30',
      badge: 'GLG Gaming',
      description: 'Die Gamer-Community hinter NexusPanel mit dedizierten Servern, Events und Turnieren.',
      external: true,
    },
    {
      title: 'Projekt auf Ko-fi unterstützen',
      url: 'https://ko-fi.com/brogameryt',
      icon: Coffee,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10 border-amber-500/30',
      badge: 'Serverkosten & Kaffee',
      description: 'Hilf mit, dedizierte Test-Hardware, Proxmox-Server und die Weiterentwicklung zu finanzieren.',
      external: true,
    },
  ];

  const ecosystemLinks = [
    {
      title: 'Pelican Eggs Vorlagenkatalog',
      url: 'https://github.com/pelican-eggs/eggs',
      icon: BookOpen,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/30',
      badge: 'Modernste Vorlagen',
      description: 'Umfangreiche Sammlung moderner Spiel-Vorlagen mit nativer Unterstützung für NexusPanel.',
      external: true,
    },
    {
      title: 'Pterodactyl Game Eggs',
      url: 'https://github.com/parkervcp/eggs',
      icon: Layers,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10 border-blue-500/30',
      badge: 'Größte Community-Sammlung',
      description: 'Hunderte Vorlagen für bewährte Gameserver, Mods und Tools zum direkten Importieren.',
      external: true,
    },
    {
      title: 'Valve Dedicated Server Liste',
      url: 'https://developer.valvesoftware.com/wiki/Dedicated_Servers_List',
      icon: Globe,
      color: 'text-indigo-400',
      bgColor: 'bg-indigo-500/10 border-indigo-500/30',
      badge: 'SteamCMD Wiki',
      description: 'Offizielle AppIDs, Installationsbefehle und Startparameter aller Steam-Dedicated-Server.',
      external: true,
    },
    {
      title: 'NexusCore Host-Agenten',
      url: '/admin/hosts',
      icon: Cpu,
      color: 'text-rose-400',
      bgColor: 'bg-rose-500/10 border-rose-500/30',
      badge: 'Multi-Node & Windows',
      description: 'Echte Bare-Metal-Hosts und Remote-Nodes anbinden und dedizierte Server steuern.',
      external: false,
    },
  ];

  return (
    <div className="max-w-5xl space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-2xl border border-seam bg-rack shadow-sm">
        <div className="flex items-center gap-4">
          <img src="/logo.svg" alt="NexusPanel Logo" className="size-14 drop-shadow-md" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2">
              NexusPanel <span className="text-amber">{t('community.title')}</span>
            </h1>
            <p className="text-sm text-dim mt-0.5">{t('community.subtitle')}</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <a
            href="https://ko-fi.com/brogameryt"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber text-black hover:bg-amber-400 transition-colors shadow-sm"
          >
            <Coffee className="size-4" />
            <span>Ko-fi</span>
          </a>
          <a
            href="https://github.com/BroGamerYT/nxpanel"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border border-seam bg-rack-2 text-ink hover:border-amber/50 transition-colors shadow-sm"
          >
            <Code2 className="size-4 text-amber" />
            <span>GitHub ⭐</span>
          </a>
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" className="flex gap-2 border-b border-seam">
        <button
          role="tab"
          aria-selected={tab === 'hub'}
          onClick={() => setTab('hub')}
          className={`px-4 h-11 -mb-px border-b-2 text-sm font-medium flex items-center gap-2 transition-colors ${
            tab === 'hub' ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink'
          }`}
        >
          <Users className="size-4" />
          {t('community.tabHub')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'steam'}
          onClick={() => setTab('steam')}
          className={`px-4 h-11 -mb-px border-b-2 text-sm font-medium flex items-center gap-2 transition-colors ${
            tab === 'steam' ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink'
          }`}
        >
          <Key className="size-4" />
          {t('community.tabSteam')}
        </button>
      </div>

      {tab === 'hub' ? (
        <div className="space-y-8">
          {/* Sektion 1: Offizielles Projekt & Quellcode */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <Code2 className="size-4 text-amber" />
                Offizielles Projekt &amp; Quellcode
              </h2>
              <span className="text-xs text-dim">BroGamerYT / nxpanel</span>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {officialLinks.map((item) => {
                const Icon = item.icon;
                const Content = (
                  <div className="flex items-start gap-4">
                    <div className={`p-2.5 rounded-lg border ${item.bgColor} ${item.color} shrink-0`}>
                      <Icon className="size-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-ink group-hover:text-amber transition-colors flex items-center gap-1.5 text-sm">
                          {item.title}
                          {item.external && <ExternalLink className="size-3 text-dim group-hover:text-amber" />}
                        </div>
                        {item.badge && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rack-2 border border-seam text-dim">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-dim mt-1.5 leading-relaxed">{item.description}</p>
                    </div>
                  </div>
                );

                return item.external ? (
                  <a
                    key={item.title}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-seam bg-rack p-4 hover:border-amber/50 hover:bg-rack-2/60 transition-all group shadow-sm"
                  >
                    {Content}
                  </a>
                ) : (
                  <Link
                    key={item.title}
                    to={item.url}
                    className="rounded-xl border border-seam bg-rack p-4 hover:border-amber/50 hover:bg-rack-2/60 transition-all group shadow-sm"
                  >
                    {Content}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Sektion 2: Community, Gaming & Livestreams */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <Users className="size-4 text-[#5865F2]" />
                Community, Gaming &amp; Livestreams
              </h2>
              <span className="text-xs text-dim">Austausch, Streams &amp; Server</span>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {communityLinks.map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.title}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-seam bg-rack p-4 hover:border-amber/50 hover:bg-rack-2/60 transition-all group shadow-sm"
                  >
                    <div className="flex items-start gap-4">
                      <div className={`p-2.5 rounded-lg border ${item.bgColor} ${item.color} shrink-0`}>
                        <Icon className="size-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-ink group-hover:text-amber transition-colors flex items-center gap-1.5 text-sm">
                            {item.title}
                            <ExternalLink className="size-3 text-dim group-hover:text-amber" />
                          </div>
                          {item.badge && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rack-2 border border-seam text-dim">
                              {item.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-dim mt-1.5 leading-relaxed">{item.description}</p>
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>
          </div>

          {/* Sektion 3: Vorlagen & Ökosystem */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <BookOpen className="size-4 text-emerald-400" />
                Spiele-Vorlagen &amp; Server-Ökosystem
              </h2>
              <span className="text-xs text-dim">Eggs, SteamCMD &amp; Nodes</span>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {ecosystemLinks.map((item) => {
                const Icon = item.icon;
                const Content = (
                  <div className="flex items-start gap-4">
                    <div className={`p-2.5 rounded-lg border ${item.bgColor} ${item.color} shrink-0`}>
                      <Icon className="size-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-ink group-hover:text-amber transition-colors flex items-center gap-1.5 text-sm">
                          {item.title}
                          {item.external && <ExternalLink className="size-3 text-dim group-hover:text-amber" />}
                        </div>
                        {item.badge && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rack-2 border border-seam text-dim">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-dim mt-1.5 leading-relaxed">{item.description}</p>
                    </div>
                  </div>
                );

                return item.external ? (
                  <a
                    key={item.title}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-seam bg-rack p-4 hover:border-amber/50 hover:bg-rack-2/60 transition-all group shadow-sm"
                  >
                    {Content}
                  </a>
                ) : (
                  <Link
                    key={item.title}
                    to={item.url}
                    className="rounded-xl border border-seam bg-rack p-4 hover:border-amber/50 hover:bg-rack-2/60 transition-all group shadow-sm"
                  >
                    {Content}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Sektion 4: Project Ethos & Open Source */}
          <div className="rounded-2xl border border-seam bg-rack p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between border-b border-seam/60 pb-3">
              <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                <Heart className="size-4 text-amber" />
                {t('community.openSourceTitle')}
              </h2>
              <span className="text-xs font-mono text-dim">AGPL-3.0 License</span>
            </div>

            <p className="text-sm text-dim leading-relaxed">
              {t('community.openSourceDesc')}
            </p>

            <div className="pt-2 flex flex-wrap gap-2.5">
              <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-rack-2 text-ink border border-seam">
                Lizenz: AGPL-3.0-or-later
              </span>
              <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-rack-2 text-ink border border-seam">
                Node.js &bull; Fastify &bull; Docker &bull; React &bull; Tailwind
              </span>
              <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-rack-2 text-amber border border-amber/30">
                100% Eigene Datenhoheit
              </span>
            </div>
          </div>
        </div>
      ) : (
        <SteamAccounts />
      )}
    </div>
  );
}
