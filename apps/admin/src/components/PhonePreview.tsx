import type { FeedResponse, Placement } from '@idb-stories/schema';
import { mountPreview, type CatalogProduct, type PreviewHandle } from '@idb-stories/web-player';
import { useEffect, useRef, useState } from 'react';
import type { CtaAllowlist } from '../api/types.js';
import { ru } from '../i18n/ru.js';

export interface PhonePreviewProps {
  feed: FeedResponse;
  placement: Placement;
  mediaOrigins: string[];
  ctaAllowlist: CtaAllowlist;
  getProducts?: ((skus: string[]) => Promise<CatalogProduct[]>) | undefined;
}

interface MountOptions {
  placement: Placement;
  mediaOrigins: string[];
  ctaAllowlist: CtaAllowlist;
}

/**
 * Веб-плеер (@idb-stories/web-player) в рамке телефона 9:16. Плеер рендерит текст только через
 * textContent, медиа берёт только с разрешённых origin (подписанные URL хранилища), CTA перед
 * «переходом» проверяет по allowlist; в превью переход не выполняется — показываем, куда ведёт кнопка.
 */
export function PhonePreview({ feed, placement, mediaOrigins, ctaAllowlist, getProducts }: PhonePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PreviewHandle | null>(null);
  const feedRef = useRef(feed);
  const [lastCta, setLastCta] = useState<string | null>(null);
  // Плеер пересоздаётся только при смене параметров, новая лента передаётся через update().
  const optionsKey = JSON.stringify({ placement, mediaOrigins, ctaAllowlist } satisfies MountOptions);

  useEffect(() => {
    feedRef.current = feed;
    handleRef.current?.update(feed);
  }, [feed]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const options = JSON.parse(optionsKey) as MountOptions;
    const handle = mountPreview(container, feedRef.current, {
      ...options,
      getProducts,
      onCta: (cta) => setLastCta(cta.href ?? `${cta.type}: ${cta.value}`),
      storage: null,
      startGroup: 0,
      autoplay: true,
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
  }, [optionsKey, getProducts]);

  return (
    <div className="phone-preview">
      <div className="phone" role="region" aria-label={ru.preview.frameLabel}>
        <div className="phone__notch" aria-hidden="true" />
        <div ref={containerRef} className="phone__screen" />
      </div>
      <p className="phone-preview__cta muted small" aria-live="polite">
        {lastCta ? ru.preview.ctaPressed(lastCta) : null}
      </p>
    </div>
  );
}
