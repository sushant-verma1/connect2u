import { Navigate, NavLink, useNavigate, useParams } from "react-router-dom";
import { cn } from "../../lib/cn";
import { DOC_SECTIONS, type DocSection } from "./sections";

/** Section order is the nav order — grouping preserves it rather than sorting, so the
 * reading path stays Quickstart → keys → verification → routing → reference. */
const GROUPS: ReadonlyArray<readonly [string, readonly DocSection[]]> = DOC_SECTIONS.reduce<
  Array<[string, DocSection[]]>
>((groups, section) => {
  const last = groups[groups.length - 1];
  if (last && last[0] === section.group) last[1].push(section);
  else groups.push([section.group, [section]]);
  return groups;
}, []);

export function DocsPage() {
  const { section: slug } = useParams();
  const navigate = useNavigate();
  const section = DOC_SECTIONS.find((candidate) => candidate.slug === slug);

  // An unknown slug is a stale or mistyped link, not an error worth a page — send it
  // to the same place /docs itself resolves to.
  if (!section) return <Navigate to="/docs/quickstart" replace />;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 md:flex-row">
      {/* Mobile: one select instead of a second sidebar competing with the app's own. */}
      <label className="md:hidden">
        <span className="sr-only">Documentation section</span>
        <select
          value={section.slug}
          onChange={(event) => navigate(`/docs/${event.target.value}`)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
        >
          {GROUPS.map(([group, sections]) => (
            <optgroup key={group} label={group}>
              {sections.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.navLabel}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <nav className="hidden w-48 shrink-0 md:block">
        <div className="sticky top-6 space-y-5">
          {GROUPS.map(([group, sections]) => (
            <div key={group}>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {group}
              </p>
              {sections.map((item) => (
                <NavLink
                  key={item.slug}
                  to={`/docs/${item.slug}`}
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-1.5 text-sm",
                      isActive
                        ? "bg-slate-100 font-medium text-slate-900"
                        : "text-slate-600 hover:text-slate-900",
                    )
                  }
                >
                  {item.navLabel}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <article className="min-w-0 flex-1 space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{section.title}</h1>
          <p className="text-sm text-slate-500">{section.subtitle}</p>
        </header>
        {section.body}
      </article>
    </div>
  );
}
