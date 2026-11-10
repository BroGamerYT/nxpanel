import { z } from 'zod';

/**
 * Eingabepruefung fuer die Registrierung eines Servers.
 *
 * Die IDs werden bewusst auf ein einfaches Muster beschnitten: sie landen
 * spaeter in Dateinamen, Container-Namen und Prozess-Kommandos.
 */
export const serverConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'ID darf nur Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten'),
  name: z.string().min(1).max(120),
  game: z.string().min(1).max(60),
  executable: z.string().min(1).max(512),
  args: z.array(z.string().max(4096)).max(64).default([]),
  workingDir: z.string().min(1).max(1024).default('.'),
  maxMemoryMb: z.number().int().positive().max(1024 * 1024).optional(),
  maxCpuPercent: z.number().int().positive().max(100).optional(),
  ports: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        hostPort: z.number().int().min(1).max(65535),
        containerPort: z.number().int().min(1).max(65535).optional(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      }),
    )
    .max(32)
    .default([]),
  env: z.record(z.string().max(8192)).optional(),
});

export type ServerConfigInput = z.infer<typeof serverConfigSchema>;
