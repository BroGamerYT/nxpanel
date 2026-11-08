import { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, X } from 'lucide-react';

interface ConfigFormEditorProps {
  content: string;
  filename: string;
  onChange: (newContent: string) => void;
  disabled?: boolean;
}

type FileType = 'ini' | 'toml' | 'yaml' | 'properties' | 'json' | 'generic';

function detectType(filename: string, content: string): FileType {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.ini')) return 'ini';
  if (lower.endsWith('.cfg') || lower.endsWith('.conf')) {
    // BepInEx & Forge .cfg Dateien nutzen oft [Sektion] wie INI/TOML
    if (/^\s*\[[^\]]+\]\s*$/m.test(content)) return 'toml';
    return 'properties';
  }
  if (lower.endsWith('.properties')) return 'properties';
  if (lower.endsWith('.json') || lower.endsWith('.json5') || lower.endsWith('.jsonc')) return 'json';
  return 'generic';
}

interface KeyValueItem {
  key: string;
  value: string;
  rawLineIndex: number;
  comment?: string;
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
  const type = detectType(filename, content);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // 1. Parser fuer INI-, TOML- und [Section]-basierte CFG-Dateien (inkl. Mod-Kommentare!)
  const iniData = useMemo(() => {
    if (type !== 'ini' && type !== 'toml') return null;
    const lines = content.split(/\r?\n/);
    const sections: IniSection[] = [];
    let currentSection: IniSection = { name: 'Allgemein', items: [] };
    let pendingComments: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComments = [];
        return;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
        const cleanComment = trimmed.replace(/^[#;]+\s*/, '').trim();
        if (cleanComment && !/^[-=~*]+$/.test(cleanComment)) {
          pendingComments.push(cleanComment);
        }
        return;
      }

      const secMatch = trimmed.match(/^\[+(.*?)\]+$/);
      if (secMatch) {
        if (currentSection.items.length > 0 || currentSection.name !== 'Allgemein') {
          sections.push(currentSection);
        }
        currentSection = { name: secMatch[1]?.trim() || 'Allgemein', items: [] };
        pendingComments = [];
        return;
      }

      // Unterstuetze einzeilige key = value Zuweisungen (keine mehrzeiligen Arrays [ ... ohne ])
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        // Mehrzeilige Listen ueberspringen, damit das Formular sie nicht beschaedigt
        if ((v.startsWith('[') && !v.endsWith(']')) || (v.startsWith('{') && !v.endsWith('}'))) {
          pendingComments = [];
          return;
        }
        const comment = pendingComments.slice(-2).join(' · ') || undefined;
        currentSection.items.push({ key: k, value: v, rawLineIndex: idx, ...(comment ? { comment } : {}) });
        pendingComments = [];
      }
    });

    if (currentSection.items.length > 0 || sections.length === 0) {
      sections.push(currentSection);
    }
    return sections.filter((s) => s.items.length > 0);
  }, [content, type]);

  // 2. Parser fuer YAML-Dateien (.yml / .yaml)
  const yamlData = useMemo(() => {
    if (type !== 'yaml') return null;
    const lines = content.split(/\r?\n/);
    const sections: IniSection[] = [];
    const bySection = new Map<string, IniSection>();
    const pathStack: Array<{ indent: number; key: string }> = [];
    let pendingComments: string[] = [];

    const getSection = (name: string) => {
      let s = bySection.get(name);
      if (!s) {
        s = { name, items: [] };
        bySection.set(name, s);
        sections.push(s);
      }
      return s;
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComments = [];
        return;
      }
      if (trimmed.startsWith('#')) {
        const c = trimmed.replace(/^#+\s*/, '').trim();
        if (c) pendingComments.push(c);
        return;
      }
      if (trimmed.startsWith('-')) return; // Listen-Elemente im Code-Editor belassen

      const indent = line.search(/\S/);
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) return;

      const key = trimmed.slice(0, colonIdx).trim();
      const rawVal = trimmed.slice(colonIdx + 1).trim();

      while (pathStack.length > 0 && pathStack[pathStack.length - 1]!.indent >= indent) {
        pathStack.pop();
      }

      if (!rawVal) {
        // Eltern-Knoten / Sektion
        pathStack.push({ indent, key });
        pendingComments = [];
        return;
      }

      if ((rawVal.startsWith('[') && !rawVal.endsWith(']')) || (rawVal.startsWith('{') && !rawVal.endsWith('}'))) {
        pendingComments = [];
        return;
      }

      const sectionName = pathStack.length > 0 ? pathStack.slice(0, 2).map((p) => p.key).join(' › ') : 'Allgemein';
      const displayKey = pathStack.length > 2 ? [...pathStack.slice(2).map((p) => p.key), key].join('.') : key;
      const comment = pendingComments.slice(-2).join(' · ') || undefined;
      getSection(sectionName).items.push({
        key: displayKey,
        value: rawVal,
        rawLineIndex: idx,
        ...(comment ? { comment } : {}),
      });
      pendingComments = [];
    });

    return sections.filter((s) => s.items.length > 0);
  }, [content, type]);

  // 3. Parser fuer Properties / CFG
  const propData = useMemo(() => {
    if (type !== 'properties') return null;
    const lines = content.split(/\r?\n/);
    const items: KeyValueItem[] = [];
    let pendingComments: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComments = [];
        return;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('//')) {
        const c = trimmed.replace(/^(#|!|\/\/)+\s*/, '').trim();
        if (c) pendingComments.push(c);
        return;
      }

      const eqIdx = line.indexOf('=') !== -1 ? line.indexOf('=') : line.indexOf(':');
      if (eqIdx > 0) {
        const k = line.substring(0, eqIdx).trim();
        const v = line.substring(eqIdx + 1).trim();
        const comment = pendingComments.slice(-2).join(' · ') || undefined;
        items.push({ key: k, value: v, rawLineIndex: idx, ...(comment ? { comment } : {}) });
        pendingComments = [];
      }
    });
    return items;
  }, [content, type]);

  // 4. Parser fuer JSON
  const jsonData = useMemo(() => {
    if (type !== 'json') return null;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ungueltiges JSON oder JSON5 mit Kommentaren
    }
    return null;
  }, [content, type]);

  // Aenderung fuer Properties / CFG
  const handlePropChange = (rawLineIndex: number, newKey: string, newValue: string) => {
    const lines = content.split(/\r?\n/);
    const line = lines[rawLineIndex] ?? '';
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const delim = line.includes(':') && !line.includes('=') ? ': ' : '=';
    lines[rawLineIndex] = `${indent}${newKey}${delim}${newValue}`;
    onChange(lines.join('\n'));
  };

  // Aenderung fuer INI / TOML (erhaelt Einrueckung und Formatierung `key = val` bzw. `key=val`)
  const handleIniChange = (rawLineIndex: number, _key: string, newValue: string) => {
    const lines = content.split(/\r?\n/);
    const line = lines[rawLineIndex] ?? '';
    const m = /^(\s*[^=]+=\s*).*$/.exec(line);
    if (m) {
      lines[rawLineIndex] = `${m[1]}${newValue}`;
    } else {
      lines[rawLineIndex] = `${_key} = ${newValue}`;
    }
    onChange(lines.join('\n'));
  };

  // Aenderung fuer YAML (erhaelt Einrueckung `  key: val`)
  const handleYamlChange = (rawLineIndex: number, newValue: string) => {
    const lines = content.split(/\r?\n/);
    const line = lines[rawLineIndex] ?? '';
    const m = /^(\s*[^:]+:\s*).*$/.exec(line);
    if (m) {
      lines[rawLineIndex] = `${m[1]}${newValue}`;
      onChange(lines.join('\n'));
    }
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
    const clean = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    const wrapQuote = (s: string) => (isDoubleQuoted ? `"${s}"` : isSingleQuoted ? `'${s}'` : s);

    const lower = clean.toLowerCase();
    const isBool = lower === 'true' || lower === 'false';
    const isNum = /^-?\d+(\.\d+)?$/.test(clean) && !clean.startsWith('00') && !isDoubleQuoted && !isSingleQuoted;

    if (isBool) {
      const boolVal = lower === 'true';
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const nextBool = !boolVal;
            const res = nextBool ? 'true' : 'false';
            onValChange(wrapQuote(res));
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
          onChange={(e) => onValChange(wrapQuote(e.target.value))}
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
        onChange={(e) => onValChange(wrapQuote(e.target.value))}
        className="w-full bg-rack-2 border border-seam rounded px-2.5 py-1 text-sm text-ink font-mono focus:border-amber focus:outline-none"
      />
    );
  };

  // Filter Logik
  const filterMatches = (key: string, val: string, comment?: string) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      key.toLowerCase().includes(q) ||
      val.toLowerCase().includes(q) ||
      (comment ? comment.toLowerCase().includes(q) : false)
    );
  };

  const sectionedData = (type === 'ini' || type === 'toml') ? iniData : type === 'yaml' ? yamlData : null;

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
            placeholder="Einstellungen in dieser Datei durchsuchen..."
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
        {/* INI / TOML / YAML Sektions-Ansicht */}
        {sectionedData && sectionedData.length > 0 && (
          <div className="space-y-4">
            {sectionedData.map((sec) => {
              const matchingItems = sec.items.filter((item) => filterMatches(item.key, item.value, item.comment));
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
                          <div className="sm:col-span-6 mb-1 sm:mb-0">
                            <label
                              htmlFor={`sec-${item.rawLineIndex}`}
                              className="font-mono text-xs sm:text-sm text-ink/90 break-words block font-medium"
                            >
                              {item.key}
                            </label>
                            {item.comment && (
                              <span className="block text-[11px] text-dim mt-0.5 leading-snug">
                                {item.comment}
                              </span>
                            )}
                          </div>
                          <div className="sm:col-span-6 flex items-center justify-end">
                            {renderValueInput(
                              item.value,
                              (next) =>
                                type === 'yaml'
                                  ? handleYamlChange(item.rawLineIndex, next)
                                  : handleIniChange(item.rawLineIndex, item.key, next),
                              `sec-${item.rawLineIndex}`
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
              .filter((item) => filterMatches(item.key, item.value, item.comment))
              .map((item) => (
                <div
                  key={`${item.key}-${item.rawLineIndex}`}
                  className="sm:grid sm:grid-cols-12 sm:gap-4 sm:items-center py-2.5 px-4 hover:bg-rack-2/30"
                >
                  <div className="sm:col-span-6 mb-1 sm:mb-0">
                    <label
                      htmlFor={`prop-${item.rawLineIndex}`}
                      className="font-mono text-xs sm:text-sm text-ink font-medium break-words block"
                    >
                      {item.key}
                    </label>
                    {item.comment && (
                      <span className="block text-[11px] text-dim mt-0.5 leading-snug">
                        {item.comment}
                      </span>
                    )}
                  </div>
                  <div className="sm:col-span-6 flex items-center justify-end">
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
        {((sectionedData !== null && sectionedData.length === 0) ||
          (type === 'properties' && (!propData || propData.length === 0)) ||
          (type === 'json' && !jsonData) ||
          type === 'generic') && (
          <div className="py-12 text-center text-dim text-sm space-y-2">
            <p>Diese Datei enthält komplexe Strukturen (z. B. Listen oder Skripte), die am besten direkt im Code-Editor bearbeitet werden.</p>
            <p className="text-xs">Klicke oben rechts auf <strong className="text-amber">Code</strong>, um die Datei direkt zu bearbeiten.</p>
          </div>
        )}
      </div>
    </div>
  );
}
