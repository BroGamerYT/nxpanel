import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  Server,
  Terminal,
  Folder,
  Archive,
  Settings,
  Sliders,
  Shield,
  Key,
  Users,
  Plus,
  Network,
  Info,
  LogOut,
  Globe,
  Gamepad2,
  Cpu,
  ArrowRight,
  X,
  FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ServerListItem } from '../lib/types';
import type { About } from '../lib/version';
import { t } from '../lib/i18n';

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  category: 'server' | 'settings' | 'permissions' | 'games' | 'actions' | 'docs';
  icon: typeof Server;
  action: () => void;
  keywords?: string[];
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { me, logout } = useAuth();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Serverliste abrufen (aus TanStack Query Cache oder Server)
  const { data: serversData } = useQuery<{ servers: ServerListItem[] }>({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerListItem[] }>('/servers'),
    enabled: open,
  });

  const { data: aboutData } = useQuery<About>({
    queryKey: ['about'],
    queryFn: () => api<About>('/about'),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const servers = serversData?.servers ?? [];

  // Fokus auf das Suchfeld setzen, wenn geöffnet
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Tastaturkürzel zum Schließen und Navigieren
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Alle durchsuchbaren Elemente zusammenstellen
  const allItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    // 1. Server & Direkt-Aktionen
    for (const s of servers) {
      const eggName = s.eggName ?? 'Gameserver';
      const statusLabel = s.status === 'running' ? 'Läuft' : s.status === 'starting' ? 'Startet' : 'Gestoppt';
      const tagStr = s.tags && s.tags.length > 0 ? ` · ${s.tags.map((tg) => `#${tg}`).join(' ')}` : '';
      const favPrefix = s.isFavorite ? '★ ' : '';

      // Server-Hauptlink
      items.push({
        id: `server-${s.id}`,
        title: `${favPrefix}${s.name}`,
        subtitle: `${eggName} · ${statusLabel} (${s.shortId})${tagStr}`,
        category: 'server',
        icon: Server,
        keywords: [s.name, eggName, s.shortId, s.status, 'server', 'instanz', ...(s.tags ?? []), ...(s.isFavorite ? ['favorit', 'favorite', 'stern'] : [])],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });

      // Direkt zu Konsole
      items.push({
        id: `server-${s.id}-console`,
        title: `${s.name} › Live-Konsole`,
        subtitle: `Direkt zur Befehlszeile & Log-Stream`,
        category: 'server',
        icon: Terminal,
        keywords: [s.name, 'konsole', 'terminal', 'befehl', 'logs'],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });

      // Direkt zu Dateien
      items.push({
        id: `server-${s.id}-files`,
        title: `${s.name} › Dateimanager`,
        subtitle: `Dateien bearbeiten, hochladen & verwalten`,
        category: 'server',
        icon: Folder,
        keywords: [s.name, 'dateien', 'ordner', 'upload', 'editor', 'files'],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });

      // Direkt zu Backups
      items.push({
        id: `server-${s.id}-backups`,
        title: `${s.name} › Backups & Wiederherstellen`,
        subtitle: `tar.zst Sicherungen erstellen, laden & sperren`,
        category: 'server',
        icon: Archive,
        keywords: [s.name, 'backup', 'sicherung', 'wiederherstellen', 'restore', 'tar'],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });

      // Direkt zu Konfigurationsdateien
      items.push({
        id: `server-${s.id}-configs`,
        title: `${s.name} › Konfigurationsdateien`,
        subtitle: `server.properties, INI, JSON im Formular bearbeiten`,
        category: 'settings',
        icon: Sliders,
        keywords: [s.name, 'config', 'konfiguration', 'server.properties', 'ini', 'cfg', 'formular'],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });

      // Direkt zu Einstellungen
      items.push({
        id: `server-${s.id}-settings`,
        title: `${s.name} › Einstellungen & Ports`,
        subtitle: `RAM, CPU, Ports und Start-Parameter`,
        category: 'settings',
        icon: Settings,
        keywords: [s.name, 'einstellungen', 'settings', 'ram', 'cpu', 'ports', 'leistung'],
        action: () => {
          navigate(`/server/${s.id}`);
          onClose();
        },
      });
    }

    // 2. Rechte, Benutzer & Sicherheit
    items.push({
      id: 'sec-2fa',
      title: 'Zwei-Faktor-Authentifizierung (2FA / TOTP)',
      subtitle: 'Sicherheit mit Authenticator-App (TOTP) einrichten',
      category: 'permissions',
      icon: Shield,
      keywords: ['2fa', 'totp', 'zwei-faktor', 'authenticator', 'sicherheit', 'rechte', 'schutz'],
      action: () => {
        navigate('/info');
        onClose();
      },
    });

    items.push({
      id: 'sec-steam',
      title: 'Steam-Konten & Steam-Guard-Verwaltung',
      subtitle: 'Zentrale SteamCMD-Konten und Guard-Codes hinterlegen',
      category: 'permissions',
      icon: Key,
      keywords: ['steam', 'steamcmd', 'steam guard', 'konto', 'passwort', 'token', 'rechte'],
      action: () => {
        navigate('/info');
        onClose();
      },
    });

    items.push({
      id: 'sec-users',
      title: 'Benutzerverwaltung & Berechtigungen (Admin)',
      subtitle: 'Rollen (Admin, Operator, Verwalter) und Zugriffsrechte',
      category: 'permissions',
      icon: Users,
      keywords: ['benutzer', 'users', 'rechte', 'rollen', 'admin', 'operator', 'verwalter', 'berechtigungen', 'audit'],
      action: () => {
        navigate('/info');
        onClose();
      },
    });

    // 3. Globale Navigation & Seiten
    items.push({
      id: 'nav-servers',
      title: 'Server-Übersicht',
      subtitle: 'Alle Gameserver und Gesamtauslastung ansehen',
      category: 'actions',
      icon: Server,
      keywords: ['server', 'uebersicht', 'dashboard', 'home', 'liste'],
      action: () => {
        navigate('/');
        onClose();
      },
    });

    if (me?.permissions['server.create']) {
      items.push({
        id: 'nav-create',
        title: 'Neuen Server erstellen',
        subtitle: 'Neuen Gameserver aus Spielvorlage einrichten',
        category: 'actions',
        icon: Plus,
        keywords: ['neu', 'erstellen', 'anlegen', 'create', 'server neu'],
        action: () => {
          navigate('/neu');
          onClose();
        },
      });
    }

    if (me?.permissions['admin.nodes']) {
      items.push({
        id: 'nav-network',
        title: 'Netzwerk & Portbereich',
        subtitle: 'Port-Bereich (28000-28999) und öffentliche Adresse',
        category: 'settings',
        icon: Network,
        keywords: ['netzwerk', 'ports', 'portbereich', 'ip', 'adresse', 'host', 'network'],
        action: () => {
          navigate('/netzwerk');
          onClose();
        },
      });
    }

    items.push({
      id: 'nav-community',
      title: 'Community & Ressourcen',
      subtitle: 'Discord, GitHub, Germany LanGame & Vorlagen',
      category: 'actions',
      icon: Globe,
      keywords: ['community', 'discord', 'github', 'pelican', 'eggs', 'glg', 'germany langame'],
      action: () => {
        navigate('/community');
        onClose();
      },
    });

    items.push({
      id: 'nav-info',
      title: 'Was ist neu & Versions-Changelog',
      subtitle: 'Versionshistorie, Geplante Aufgaben (TODO) & Updates',
      category: 'actions',
      icon: Info,
      keywords: ['info', 'version', 'changelog', 'update', 'was ist neu', 'todo'],
      action: () => {
        navigate('/info');
        onClose();
      },
    });

    // Markdown-Dokumente (.md) zum direkten Springen
    if (aboutData?.docs) {
      for (const doc of aboutData.docs) {
        items.push({
          id: `doc-${doc.slug}`,
          title: `Doku: ${doc.title}`,
          subtitle: `${doc.filename} · ${doc.categoryLabel} (${doc.sizeFormatted})`,
          category: 'docs',
          icon: FileText,
          keywords: ['doku', 'dokumentation', 'md', 'markdown', doc.slug, doc.filename, doc.title, doc.categoryLabel, doc.description],
          action: () => {
            navigate(`/docs?tab=doku&doc=${doc.slug}`);
            onClose();
          },
        });
      }
    }

    // 4. Spiele & Vorlagen (Eggs)
    const gamesList = [
      { name: 'Minecraft Java', desc: 'Paper, Purpur, Fabric, Forge, NeoForge, Vanilla, Modpacks' },
      { name: 'Minecraft Bedrock', desc: 'Handy, Konsole, Windows-App' },
      { name: 'ARK: Survival Ascended', desc: 'Unreal Engine 5 Server unter Proton' },
      { name: 'Palworld', desc: 'Multiplayer Dedicated Server mit RCON' },
      { name: 'Rust', desc: 'Oxide/uMod und WebRCON Support' },
      { name: 'Valheim', desc: 'Crossplay für PC & Xbox' },
      { name: 'Counter-Strike 2', desc: 'Source 2 Server mit GSLT' },
      { name: 'Satisfactory', desc: 'Fabrikbau mit Auto-Save' },
      { name: '7 Days to Die', desc: 'Zufallswelten & Blutmond' },
      { name: 'Sons of the Forest', desc: 'Survival Horror unter Proton' },
      { name: 'Farming Simulator 25', desc: 'Landwirtschafts-Simulator mit Webinterface' },
      { name: 'TeamSpeak 6', desc: 'Modernes Voice-System (TeaSpeak/TS6)' },
      { name: 'TeamSpeak 3', desc: 'Klassischer TS3 Sprachserver' },
    ];

    for (const g of gamesList) {
      items.push({
        id: `game-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title: `Spielvorlage: ${g.name}`,
        subtitle: g.desc,
        category: 'games',
        icon: Gamepad2,
        keywords: [g.name, 'spiel', 'egg', 'template', 'vorlage', g.desc],
        action: () => {
          navigate('/neu');
          onClose();
        },
      });
    }

    // 5. Abmelden
    items.push({
      id: 'act-logout',
      title: 'Abmelden',
      subtitle: `Sitzung für Benutzer ${me?.user.username} beenden`,
      category: 'actions',
      icon: LogOut,
      keywords: ['logout', 'abmelden', 'beenden', 'sign out'],
      action: () => {
        void logout();
        onClose();
      },
    });

    return items;
  }, [servers, me, navigate, onClose, logout]);

  // Treffer filtern
  const filteredItems = useMemo(() => {
    if (!query.trim()) {
      // Standard-Vorschläge anzeigen (Server, Schnelle Navigation, Rechte)
      return allItems.slice(0, 15);
    }

    const q = query.toLowerCase().trim();
    return allItems.filter((item) => {
      if (item.title.toLowerCase().includes(q)) return true;
      if (item.subtitle?.toLowerCase().includes(q)) return true;
      if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [allItems, query]);

  // Tastaturnavigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredItems[selectedIndex];
      if (selected) {
        selected.action();
      }
    }
  };

  // Ausgewähltes Element ins Sichtfeld scrollen
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  const categoryLabels: Record<CommandItem['category'], string> = {
    server: 'Server & Instanzen',
    settings: 'Einstellungen & Konfiguration',
    permissions: 'Rechte & Benutzerverwaltung',
    games: 'Spiel-Vorlagen (Eggs)',
    actions: 'Navigation & Aktionen',
    docs: 'Dokumentation & Leitfäden (.md)',
  };

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-start justify-center p-3 sm:p-6 sm:pt-20 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[80vh] border-t-2 border-t-amber"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Suchfeld */}
        <div className="relative flex items-center px-4 py-3.5 border-b border-seam bg-rack-2/40">
          <Search className="size-5 text-amber shrink-0 mr-3 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Globale Suche: Server, Einstellungen, Rechte, Dateien..."
            className="w-full bg-transparent text-sm sm:text-base text-ink placeholder:text-dim/60 focus:outline-none"
          />
          {query ? (
            <button
              onClick={() => {
                setQuery('');
                setSelectedIndex(0);
              }}
              className="p-1 rounded text-dim hover:text-ink text-xs"
            >
              <X className="size-4" />
            </button>
          ) : (
            <kbd className="hidden sm:inline-block text-[11px] font-mono text-dim border border-seam bg-rack-1 px-1.5 py-0.5 rounded">
              ESC zum Schließen
            </kbd>
          )}
        </div>

        {/* Ergebnisliste */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-2 divide-y divide-seam/30">
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center text-dim text-sm space-y-1">
              <Search className="size-8 mx-auto text-dim/40 mb-2" />
              <p>Keine Treffer für „{query}“ gefunden.</p>
              <p className="text-xs text-dim/70">
                Suche nach Servername, Port, „Rechte“, „2FA“, „Config“ oder einem Spielnamen.
              </p>
            </div>
          ) : (
            <div className="space-y-1 py-1">
              {filteredItems.map((item, idx) => {
                const Icon = item.icon;
                const isSelected = idx === selectedIndex;
                const isFirstOfCategory =
                  idx === 0 || filteredItems[idx - 1]?.category !== item.category;

                return (
                  <div key={item.id}>
                    {isFirstOfCategory && (
                      <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold text-dim uppercase tracking-wider">
                        {categoryLabels[item.category]}
                      </div>
                    )}
                    <button
                      type="button"
                      data-index={idx}
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition ${
                        isSelected
                          ? 'bg-amber text-black font-medium shadow-sm'
                          : 'text-ink hover:bg-rack-2/60'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${
                            isSelected ? 'bg-black/15 text-black' : 'bg-rack-2 text-dim'
                          }`}
                        >
                          <Icon className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <div className={`text-sm truncate ${isSelected ? 'font-semibold text-black' : 'text-ink'}`}>
                            {item.title}
                          </div>
                          {item.subtitle && (
                            <div className={`text-xs truncate ${isSelected ? 'text-black/80' : 'text-dim'}`}>
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                      <ArrowRight
                        className={`size-4 shrink-0 ml-2 transition-transform ${
                          isSelected ? 'translate-x-0.5 text-black' : 'opacity-0'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Tastatur-Hilfe Fusszeile */}
        <div className="px-4 py-2 border-t border-seam bg-rack-2/30 flex items-center justify-between text-[11px] text-dim font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigieren</span>
            <span>↵ Auswählen</span>
            <span>ESC Schließen</span>
          </div>
          <span>{filteredItems.length} Treffer</span>
        </div>
      </div>
    </div>
  );
}
