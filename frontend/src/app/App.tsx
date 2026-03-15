import { useEffect } from 'react';
import { Wizard } from './components/wizard';

document.title = 'Infoblox Universal DDI Token Assessment';

export default function App() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<circle cx="16" cy="16" r="16" fill="#1d4ed8"/>' +
          '<text x="16" y="22" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#fff">I</text>' +
          '</svg>'
      );
    if (!link.parentNode) {
      document.head.appendChild(link);
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex-1">
        <Wizard />
      </div>
    </div>
  );
}
