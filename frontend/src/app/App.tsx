import { useState, useEffect } from 'react';
import { Wizard } from './components/wizard';

interface VersionInfo {
  version: string;
  commit: string;
}

export default function App() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch('/api/v1/version')
      .then(r => r.ok ? r.json() : null)
      .then((data: VersionInfo | null) => {
        if (data) setVersionInfo(data);
      })
      .catch(() => {
        // Footer is non-critical — silently skip if backend unavailable (demo mode)
      });
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex-1">
        <Wizard />
      </div>
      {versionInfo && (
        <footer className="py-2 px-4 text-center text-xs text-muted-foreground border-t border-border">
          DDI Scanner {versionInfo.version} &middot; {versionInfo.commit}
        </footer>
      )}
    </div>
  );
}
