import { useEffect } from 'react';
import { Wizard } from './components/wizard';

export default function App() {
  useEffect(() => {
    // Set page title
    document.title = 'Infoblox Universal DDI Token Assessment';

    // Set favicon to Infoblox favicon (inline SVG — no external requests)
    const existingFavicon = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null;
    const favicon = existingFavicon || document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#002B49"/><rect x="4" y="4" width="24" height="24" rx="4" fill="#F37021"/><text x="16" y="24" fill="#fff" font-size="20" font-weight="700" text-anchor="middle" font-family="sans-serif">i</text></svg>')}`;
    if (!existingFavicon) {
      document.head.appendChild(favicon);
    }
  }, []);

  return <Wizard />;
}
