import { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, Plus, Sliders, Check, X } from 'lucide-react';

interface ConfigFormEditorProps {
  content: string;
  filename: string;
  onChange: (newContent: string) => void;
  disabled?: boolean;
}

type FileType = 'ini' | 'properties' | 'json' | 'generic';

function detectType(filename: string): FileType {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.ini')) return 'ini';
  if (lower.endsWith('.properties') || lower.endsWith('.cfg') || lower.endsWith('.conf')) return 'properties';
  if (lower.endsWith('.json')) return 'json';
  return 'generic';
}

interface KeyValueItem {
  key: string;
  value: string;
  rawLineIndex: number;
}

interface IniSection {
  name: string;
  items: KeyValueItem[];
}

export function ConfigFormEditor({
  content,
  filename,
  onChange,
  disabled = false,
}: ConfigFormEditorProps) {
  const type = detectType(filename);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // 1. Parser fuer INI-Dateien
  const iniData = useMemo(() => {
    if (type !== 'ini') return null;
    const lines = content.split(/\r?\n/);
    const sections: IniSection[] = [];
    let currentSection: IniSection = { name: 'Allgemein', items: [] };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return;

      const secMatch = trimmed.match(/^\[(.*)\]$/);
      if (secMatch) {
        if (currentSection.items.length > 0 || currentSection.name !== 'Allgemein') {
          sections.push(currentSection);
        }
        currentSection = { name: secMatch[1] ?? '', items: [] };
        return;
      }

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        currentSection.items.push({ key: k, value: v, rawLineIndex: idx });
      }
    });

    if (currentSection.items.length > 0 || sections.length === 0) {
      sections.push(currentSection);
    }
    return sections;
  }, [content, type]);

  // 2. Parser fuer Properties / CFG
  const propData = useMemo(() => {
    if (type !== 'properties') return null;
    const lines = content.split(/\r?\n/);
    const items: KeyValueItem[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('//')) return;

      const eqIdx = line.indexOf('=') !== -1 ? line.indexOf('=') : line.indexOf(':');
      if (eqIdx > 0) {
        const k = line.substring(0, eqIdx).trim();
        const v = line.substring(eqIdx + 1).trim();
        items.push({ key: k, value: v, rawLineIndex: idx });
      }
    });
    return items;
  }, [content, type]);

  // 3. Parser fuer JSON
  const jsonData = useMemo(() => {
    if (type !== 'json') return null;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ungueltiges JSON
    }
    return null;
  }, [content, type]);

  // Aenderung fuer Properties / CFG
  const handlePropChange = (rawLineIndex: number, newKey: string, newValue: string) => {
    const lines = content.split(/\r?\n/);
    const line = lines[rawLineIndex] ?? '';
    const delim = line.includes(':') && !line.includes('=') ? ':' : '=';
    lines[rawLineIndex] = `${newKey}${delim}${newValue}`;
    onChange(lines.join('\n'));
  };

  // Aenderung fuer INI
  const handleIniChange = (rawLineIndex: number, newKey: string, newValue: string) => {
    const lines = content.split(/\r?\n/);
    lines[rawLineIndex] = `${newKey}=${newValue}`;
    onChange(lines.join('\n'));
  };

  // Aenderung fuer JSON
  const handleJsonChange = (key: string, newValue: unknown) => {
    if (!jsonData) return;
    const updated = { ...jsonData, [key]: newValue };
    onChange(JSON.stringify(updated, null, 2));
  };

  const toggleSection = (name: string) => {
    setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  // Render-Helfer fuer Wert-Eingabefelder
  const renderValueInput = (
    value: string,
    onValChange: (next: string) => void,
    fieldId: string
  ) => {
    const clean = value.replace(/^"(.*)"$/, '$1');
    const isQuoted = value.startsWith('"') && value.endsWith('"');
    const lower = clean.toLowerCase();
    const isBool = lower === 'true' || lower === 'false' || lower === '1' || lower === '0';
    const isNum = /^-?\d+(\.\d+)?$/.test(clean) && !clean.startsWith('00');

    if (isBool) {
      const boolVal = lower === 'true' || lower === '1';
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const nextBool = !boolVal;
            const res = lower === '1' || lower === '0' ? (nextBool ? '1' : '0') : nextBool ? 'true' : 'false';
            onValChange(isQuoted ? `"${res}"` : res);
          }}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            boolVal ? 'bg-emerald-500' : 'bg-rack-2'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              boolVal ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      );
    }

    if (isNum) {
      return (
        <input
          id={fieldId}
          type="number"
          disabled={disabled}
          value={clean}
          onChange={(e) => onValChange(isQuoted ? `"${e.target.value}"` : e.target.value)}
          className="w-full sm:w-48 bg-rack-2 border border-seam rounded px-2.5 py-1 text-sm text-ink font-mono focus:border-amber focus:outline-none"
        />
      );
    }

    return (
      <input
        id={fieldId}
        type="text"
        disabled={disabled}
        value={clean}
        onChange={(e) => onValChange(isQuoted ? `"${e.target.value}"` : e.target.value)}
        className="w-full bg-rack-2 border border-seam rounded px-2.5 py-1 text-sm text-ink font-mono focus:border-amber focus:outline-none"
      />
    );
  };

  // Filter Logik
  const filterMatches = (key: string, val: string) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return key.toLowerCase().includes(q) || val.toLowerCase().includes(q);
  };

  return (
    <div className="flex-1 flex flex-col bg-rack-1 overflow-hidden">
      {/* Such- und Statusleiste */}
      <div className="px-4 py-2.5 border-b border-seam bg-rack-2/40 flex items-center justify-between gap-3 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="size-3.5 text-dim absolute left-2.5 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Einstellungen durchsuchen..."
            className="w-full bg-rack-1 border border-seam rounded pl-8 pr-3 py-1 text-xs text-ink placeholder:text-dim/60 focus:outline-none focus:border-amber"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2 text-dim hover:text-ink text-xs"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="text-xs text-dim font-mono">
          Format: <span className="text-amber uppercase">{type}</span>
        </div>
      </div>

      {/* Formular-Inhalt */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* INI-Ansicht */}
        {type === 'ini' && iniData && (
          <div className="space-y-4">
            {iniData.map((sec) => {
              const matchingItems = sec.items.filter((item) => filterMatches(item.key, item.value));
              if (searchQuery && matchingItems.length === 0) return null;

              const isCollapsed = !!collapsedSections[sec.name];
              return (
                <div key={sec.name} className="border border-seam rounded-lg overflow-hidden bg-rack-1/60">
                  <button
                    type="button"
                    onClick={() => toggleSection(sec.name)}
                    className="w-full px-4 py-2.5 bg-rack-2/60 hover:bg-rack-2 flex items-center justify-between text-left transition"
                  >
                    <div className="flex items-center gap-2">
                      {isCollapsed ? (
                        <ChevronRight className="size-4 text-dim" />
                      ) : (
                        <ChevronDown className="size-4 text-dim" />
                      )}
                      <span className="font-semibold text-sm text-ink font-mono">[{sec.name}]</span>
                    </div>
                    <span className="text-xs text-dim bg-rack-1 px-2 py-0.5 rounded border border-seam font-mono">
                      {matchingItems.length} {matchingItems.length === 1 ? 'Eintrag' : 'Einträge'}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="divide-y divide-seam/60 p-2 sm:p-4 space-y-3 sm:space-y-0">
                      {matchingItems.map((item) => (
                        <div
                          key={`${sec.name}-${item.key}-${item.rawLineIndex}`}
                          className="sm:grid sm:grid-cols-12 sm:gap-4 sm:items-center py-2.5 hover:bg-rack-2/20 px-2 rounded"
                        >
                          <label
                            htmlFor={`ini-${item.rawLineIndex}`}
                            className="sm:col-span-5 font-mono text-xs sm:text-sm text-ink/90 break-words mb-1 sm:mb-0 block font-medium"
                          >
                            {item.key}
                          </label>
                          <div className="sm:col-span-7 flex items-center justify-end">
                            {renderValueInput(
                              item.value,
                              (next) => handleIniChange(item.rawLineIndex, item.key, next),
                              `ini-${item.rawLineIndex}`
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Properties / CFG Ansicht */}
        {type === 'properties' && propData && (
          <div className="border border-seam rounded-lg overflow-hidden bg-rack-1/60 divide-y divide-seam/60">
            {propData
              .filter((item) => filterMatches(item.key, item.value))
              .map((item) => (
                <div
                  key={`${item.key}-${item.rawLineIndex}`}
                  className="sm:grid sm:grid-cols-12 sm:gap-4 sm:items-center py-2.5 px-4 hover:bg-rack-2/30"
                >
                  <label
                    htmlFor={`prop-${item.rawLineIndex}`}
                    className="sm:col-span-5 font-mono text-xs sm:text-sm text-ink font-medium break-words mb-1 sm:mb-0 block"
                  >
                    {item.key}
                  </label>
                  <div className="sm:col-span-7 flex items-center justify-end">
                    {renderValueInput(
                      item.value,
                      (next) => handlePropChange(item.rawLineIndex, item.key, next),
                      `prop-${item.rawLineIndex}`
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* JSON Ansicht */}
        {type === 'json' && jsonData && (
          <div className="border border-seam rounded-lg overflow-hidden bg-rack-1/60 divide-y divide-seam/60">
            {Object.entries(jsonData)
              .filter(([k, v]) => filterMatches(k, String(v)))
              .map(([k, v]) => (
                <div
                  key={k}
                  className="sm:grid sm:grid-cols-12 sm:gap-4 sm:items-center py-2.5 px-4 hover:bg-rack-2/30"
                >
                  <label
                    htmlFor={`json-${k}`}
                    className="sm:col-span-5 font-mono text-xs sm:text-sm text-ink font-medium break-words mb-1 sm:mb-0 block"
                  >
                    {k}
                  </label>
                  <div className="sm:col-span-7 flex items-center justify-end">
                    {typeof v === 'boolean' ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => handleJsonChange(k, !v)}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                          v ? 'bg-emerald-500' : 'bg-rack-2'
                        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <span
                          className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            v ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    ) : typeof v === 'number' ? (
                      <input
                        id={`json-${k}`}
                        type="number"
                        disabled={disabled}
                        value={v}
                        onChange={(e) => handleJsonChange(k, Number(e.target.value))}
                        className="w-full sm:w-48 bg-rack-2 border border-seam rounded px-2.5 py-1 text-sm text-ink font-mono focus:border-amber focus:outline-none"
                      />
                    ) : (
                      <input
                        id={`json-${k}`}
                        type="text"
                        disabled={disabled}
                        value={String(v ?? '')}
                        onChange={(e) => handleJsonChange(k, e.target.value)}
                        className="w-full bg-rack-2 border border-seam rounded px-2.5 py-1 text-sm text-ink font-mono focus:border-amber focus:outline-none"
                      />
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* Fallback falls nicht parst */}
        {((type === 'ini' && (!iniData || iniData.length === 0)) ||
          (type === 'properties' && (!propData || propData.length === 0)) ||
          (type === 'json' && !jsonData) ||
          type === 'generic') && (
          <div className="py-12 text-center text-dim text-sm space-y-2">
            <p>Diese Datei enthält keine erkannten Standard-Schlüsselwerte für das Formular.</p>
            <p className="text-xs">Nutze den Code-Editor oben rechts zur manuellen Bearbeitung.</p>
          </div>
        )}
      </div>
    </div>
  );
}
