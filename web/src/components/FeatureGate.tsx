import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useFeatures } from '../lib/features';
import { t } from '../lib/i18n';

/**
 * Zeigt eine Seite nur, wenn die Gegenstelle die Funktion hat. Sonst steht hier
 * ein klarer Hinweis - etwa wenn jemand die Adresse einer Admin-Seite im
 * eigenstaendigen NexusCore aufruft - statt eines "Nicht gefunden" der Schnittstelle.
 */
export function FeatureGate({ feature, children }: { feature: string; children: ReactNode }) {
  const { has } = useFeatures();
  if (has(feature)) return <>{children}</>;
  return (
    <div className="max-w-xl rounded-lg border border-seam bg-rack p-6 space-y-2">
      <h1 className="text-base font-semibold">{t('standalone.unavailableTitle')}</h1>
      <p className="text-sm text-dim">{t('standalone.unavailableText')}</p>
      <Link to="/" className="inline-block text-sm text-amber hover:underline">
        {t('standalone.backToServers')}
      </Link>
    </div>
  );
}
