import { useState } from 'react';
import { ExternalLink, Code2, MessageSquare, BookOpen, Key, Users, Server, Heart } from 'lucide-react';
import { SteamAccounts } from '../components/SteamAccounts';
import { t } from '../lib/i18n';

export function Community() {
  const [tab, setTab] = useState<'hub' | 'steam'>('hub');

  return (
    <div className="max-w-4xl space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <img src="/logo.svg" alt="NexusPanel Logo" className="size-12 drop-shadow-md" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2">
            NexusPanel <span className="text-amber">{t('community.title')}</span>
          </h1>
          <p className="text-sm text-dim mt-0.5">{t('community.subtitle')}</p>
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" className="flex gap-2 border-b border-seam">
        <button
          role="tab"
          aria-selected={tab === 'hub'}
          onClick={() => setTab('hub')}
          className={`px-4 h-10 -mb-px border-b-2 text-sm font-medium flex items-center gap-2 transition-colors ${
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
          className={`px-4 h-10 -mb-px border-b-2 text-sm font-medium flex items-center gap-2 transition-colors ${
            tab === 'steam' ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink'
          }`}
        >
          <Key className="size-4" />
          {t('community.tabSteam')}
        </button>
      </div>

      {tab === 'hub' ? (
        <div className="space-y-6">
          {/* Quick Links Grid */}
          <div className="grid sm:grid-cols-2 gap-4">
            <a
              href="https://github.com/dominik/nxpanel"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-seam bg-rack p-5 hover:border-amber/50 transition-colors flex items-start gap-4 group"
            >
              <div className="p-2.5 rounded-md bg-rack-2 border border-seam text-amber group-hover:bg-amber/10 transition-colors">
                <Code2 className="size-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink flex items-center gap-1.5">
                  GitHub Repository <ExternalLink className="size-3.5 text-dim" />
                </div>
                <p className="text-xs text-dim mt-1">{t('community.githubDesc')}</p>
              </div>
            </a>

            <a
              href="https://discord.gg/germanylangame"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-seam bg-rack p-5 hover:border-amber/50 transition-colors flex items-start gap-4 group"
            >
              <div className="p-2.5 rounded-md bg-rack-2 border border-seam text-indigo-400 group-hover:bg-indigo-500/10 transition-colors">
                <MessageSquare className="size-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink flex items-center gap-1.5">
                  Discord & Support <ExternalLink className="size-3.5 text-dim" />
                </div>
                <p className="text-xs text-dim mt-1">{t('community.discordDesc')}</p>
              </div>
            </a>

            <a
              href="https://github.com/pelican-eggs/eggs"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-seam bg-rack p-5 hover:border-amber/50 transition-colors flex items-start gap-4 group"
            >
              <div className="p-2.5 rounded-md bg-rack-2 border border-seam text-led-run group-hover:bg-led-run/10 transition-colors">
                <BookOpen className="size-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink flex items-center gap-1.5">
                  Pterodactyl & Pelican Eggs <ExternalLink className="size-3.5 text-dim" />
                </div>
                <p className="text-xs text-dim mt-1">{t('community.eggsDesc')}</p>
              </div>
            </a>

            <div className="rounded-lg border border-seam bg-rack p-5 flex items-start gap-4">
              <div className="p-2.5 rounded-md bg-rack-2 border border-seam text-amber">
                <Server className="size-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink">Germany LanGame</div>
                <p className="text-xs text-dim mt-1">{t('community.germanyLanGameDesc')}</p>
              </div>
            </div>
          </div>

          {/* Project Ethos & Contributing */}
          <div className="rounded-lg border border-seam bg-rack p-6 space-y-4">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Heart className="size-4 text-amber" />
              {t('community.openSourceTitle')}
            </h2>
            <p className="text-sm text-dim leading-relaxed">
              {t('community.openSourceDesc')}
            </p>
            <div className="pt-2 flex flex-wrap gap-3">
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-rack-2 text-ink border border-seam">
                Lizenz: AGPL-3.0-or-later
              </span>
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-rack-2 text-ink border border-seam">
                Node.js &bull; Fastify &bull; Docker &bull; React
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
