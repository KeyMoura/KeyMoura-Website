import Link from "next/link";
import type { BrowseMenu } from "@/lib/commerce/catalogBrowse";

type CatalogCategoryTreeProps = {
  menu: BrowseMenu;
  variant: "rail" | "drawer";
  onNavigate?: () => void;
};

/** One hierarchy for every responsive shell; only its presentation changes. */
export default function CatalogCategoryTree({ menu, variant, onNavigate }: CatalogCategoryTreeProps) {
  const itemClass = variant === "rail" ? "catalog-rail-link" : "catalog-drawer-item";
  const childClass = variant === "rail" ? "catalog-rail-sublink" : "catalog-drawer-item is-child";

  return (
    <ul className={variant === "rail" ? "catalog-rail-list" : "catalog-category-tree"}>
      <li>
        <Link
          href={menu.all.href}
          onClick={onNavigate}
          aria-current={menu.all.isActive ? "page" : undefined}
          className={`${itemClass}${menu.all.isActive ? " is-active" : ""}`}
        >
          <span className="catalog-rail-label">{menu.all.name}</span>
          <span className="catalog-rail-count">{menu.all.count}</span>
        </Link>
      </li>
      {menu.categories.map((entry) => (
        <li key={entry.id}>
          <Link
            href={entry.href}
            onClick={onNavigate}
            aria-current={entry.isActive ? "page" : undefined}
            className={`${itemClass}${entry.isActive ? " is-active" : ""}${
              entry.isCurrentBranch && !entry.isActive ? " is-branch" : ""
            }`}
          >
            <span className="catalog-rail-label">{entry.name}</span>
            <span className="catalog-rail-count">{entry.count}</span>
          </Link>
          {(variant === "drawer" || entry.isCurrentBranch) && entry.children.length ? (
            <ul className={variant === "rail" ? "catalog-rail-sublist" : "catalog-drawer-sublist"} aria-label={`${entry.name} subcategories`}>
              {entry.children.map((child) => (
                <li key={child.id}>
                  <Link
                    href={child.href}
                    onClick={onNavigate}
                    aria-current={child.isActive ? "page" : undefined}
                    className={`${childClass}${child.isActive ? " is-active" : ""}`}
                  >
                    <span className="catalog-rail-label">{child.name}</span>
                    <span className="catalog-rail-count">{child.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
