import { useState, useEffect } from 'react';

interface OutlineNavSection {
  id: string;
  label: string;
}

interface OutlineNavProps {
  sections: OutlineNavSection[];
  expandHandlers?: Record<string, () => void>;
}

function useScrollSpy(sectionIds: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const elements = sectionIds
      .map(id => document.getElementById(id))
      .filter(Boolean) as HTMLElement[];

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (intersecting.length > 0) {
          setActiveId(intersecting[0].target.id);
        }
      },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    );

    elements.forEach(el => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sectionIds)]);

  return activeId;
}

function scrollToSection(
  sectionId: string,
  expandHandlers?: Record<string, () => void>
) {
  const handler = expandHandlers?.[sectionId];
  if (handler) {
    handler();
    requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  } else {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }
}

export function OutlineNav({ sections, expandHandlers }: OutlineNavProps) {
  const sectionIds = sections.map(s => s.id);
  const activeId = useScrollSpy(sectionIds);

  return (
    <nav aria-label="Report sections" className="hidden xl:block w-[180px] shrink-0 ml-6 self-start sticky top-6">
      <div className="border-l border-[var(--border)] py-4">
        {sections.map(section => {
          const isActive = activeId === section.id;
          return (
            <button
              key={section.id}
              type="button"
              className={`block w-full text-left pl-3 pr-2 py-2 text-[12px] transition-colors duration-150 border-l-2 -ml-[1px] ${
                isActive
                  ? 'border-l-[var(--infoblox-blue)] text-[var(--infoblox-blue)] font-semibold'
                  : 'border-l-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => scrollToSection(section.id, expandHandlers)}
            >
              {section.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
