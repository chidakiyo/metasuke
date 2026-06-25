import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

// メール本文の安全表示。
// 顧客から届くHTMLは信頼できない入力のため、多層防御で隔離表示する:
//  1) DOMPurify でサニタイズ（script/iframe/on* 等を除去）
//  2) sandbox="allow-scripts"（allow-same-origin なし）の iframe = オペークoriginでアプリ本体から隔離
//  3) CSP（nonce付きで高さ計測スクリプトのみ許可・外部リソース遮断）
//  4) 外部画像は既定ブロック → ユーザー操作で表示（トラッキング防止）
//  5) HTML が無ければテキストにフォールバック

// 画像など外部リソースを参照する属性
const RESOURCE_ATTRS = ['src', 'srcset', 'background', 'poster'];

function sanitize(html: string, allowImages: boolean): { clean: string; hadImages: boolean } {
  let hadImages = false;
  const hook = (node: Element) => {
    for (const attr of RESOURCE_ATTRS) {
      if (node.hasAttribute(attr)) {
        const v = node.getAttribute(attr) ?? '';
        // インライン画像(cid:/data:)以外の外部参照をブロック対象とみなす
        if (v && !/^cid:/i.test(v)) {
          if (!/^data:/i.test(v)) hadImages = true;
          if (!allowImages && !/^data:/i.test(v)) node.removeAttribute(attr);
        }
      }
    }
    // style 内の url(...) 経由の画像読み込みも遮断
    if (!allowImages && node.hasAttribute('style')) {
      const s = node.getAttribute('style') ?? '';
      if (/url\s*\(/i.test(s)) {
        hadImages = true;
        node.setAttribute('style', s.replace(/url\s*\([^)]*\)/gi, 'none'));
      }
    }
  };
  DOMPurify.addHook('afterSanitizeAttributes', hook);
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base', 'svg'],
    ADD_ATTR: ['target'],
  }) as unknown as string;
  DOMPurify.removeHook('afterSanitizeAttributes');
  return { clean, hadImages };
}

function buildSrcDoc(cleanHtml: string, nonce: string, allowImages: boolean): string {
  const imgSrc = allowImages ? 'https: data:' : 'data:';
  // CSP: 既定で全遮断。自前スクリプトは nonce のみ許可、スタイルはメールが多用するため inline 許可。
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src data:",
  ].join('; ');
  // 高さ計測スクリプト（オペークoriginから parent へ postMessage）
  const heightScript = `<script nonce="${nonce}">(function(){
    function send(){try{parent.postMessage({__mb:'${nonce}',h:document.documentElement.scrollHeight},'*');}catch(e){}}
    window.addEventListener('load',send);setTimeout(send,60);setTimeout(send,400);
    Array.prototype.forEach.call(document.images,function(i){i.addEventListener('load',send);i.addEventListener('error',send);});
  })();<\/script>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>html,body{margin:0;padding:0}body{font:14px/1.55 system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;color:#111;padding:8px;word-break:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#2563eb}table{max-width:100%;border-collapse:collapse}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:3px solid #ddd;color:#555}</style>
</head><body>${cleanHtml}${heightScript}</body></html>`;
}

export function MessageBody({ bodyHtml, bodyText }: { bodyHtml: string | null; bodyText: string | null }) {
  const hasHtml = !!bodyHtml && bodyHtml.trim() !== '';
  const [mode, setMode] = useState<'html' | 'text'>(hasHtml ? 'html' : 'text');
  const [allowImages, setAllowImages] = useState(false);
  const [height, setHeight] = useState(60);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // iframe ごとに一意な nonce（postMessage 検証にも使用）
  const nonce = useMemo(() => crypto.randomUUID().replace(/-/g, ''), []);

  const { srcDoc, hadImages } = useMemo(() => {
    if (!hasHtml) return { srcDoc: '', hadImages: false };
    const { clean, hadImages } = sanitize(bodyHtml as string, allowImages);
    return { srcDoc: buildSrcDoc(clean, nonce, allowImages), hadImages };
  }, [bodyHtml, hasHtml, allowImages, nonce]);

  useEffect(() => {
    if (mode !== 'html') return;
    function onMsg(e: MessageEvent) {
      // 送信元 iframe と nonce の両方を検証
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { __mb?: string; h?: number };
      if (d && d.__mb === nonce && typeof d.h === 'number') {
        setHeight(Math.min(Math.max(d.h + 4, 40), 4000));
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [mode, nonce]);

  if (mode === 'text' || !hasHtml) {
    return (
      <div>
        <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{bodyText || (hasHtml ? '' : '（本文なし）')}</div>
        {hasHtml && (
          <button onClick={() => setMode('html')} style={toggleBtn}>
            HTMLで表示
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        {hadImages && !allowImages && (
          <button onClick={() => setAllowImages(true)} style={{ ...toggleBtn, color: '#92400e', borderColor: '#d97706' }}>
            画像を表示
          </button>
        )}
        {bodyText && bodyText.trim() !== '' && (
          <button onClick={() => setMode('text')} style={toggleBtn}>
            テキストで表示
          </button>
        )}
      </div>
      <iframe
        ref={iframeRef}
        title="メール本文"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        style={{ width: '100%', height, border: '1px solid #f0f0f0', borderRadius: 6, background: '#fff', display: 'block' }}
      />
      {hadImages && !allowImages && (
        <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>外部画像はトラッキング防止のためブロックしています。</div>
      )}
    </div>
  );
}

const toggleBtn = {
  padding: '2px 8px',
  fontSize: 12,
  background: '#fff',
  color: '#2563eb',
  border: '1px solid #2563eb',
  borderRadius: 6,
  cursor: 'pointer',
} as const;
