"use client";

import ProductCard from "@/components/ProductCard";
import { Badge, EmptyState, Field, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";

import { productFixtures, staffCatalogFixtures } from "./fixtures";
import { StaffSurfaces } from "./surfaces";

const money = (cents: number | null) => (cents == null ? "Quote only" : `$${(cents / 100).toFixed(2)}`);

function Group({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="staff-section" data-harness-group={id}>
      <div className="staff-section-head">
        <div className="min-w-0">
          <h2 className="staff-section-title">{title}</h2>
          {note ? <p className="staff-section-description">{note}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function VisualHarness() {
  return (
    <div className="page-container-wide page-stack" data-visual-harness="true">
      <header className="staff-page-header">
        <div className="staff-page-heading">
          <p className="staff-page-kind">Development only</p>
          <h1 className="staff-page-title">Visual system harness</h1>
          <p className="staff-page-description">
            The real shared components, rendered against fixtures. Every role the Appearance editor claims to control
            appears here so the claim can be checked rather than asserted.
          </p>
        </div>
      </header>

      {/* ---------------- Buttons ---------------- */}
      <Group id="buttons" title="Buttons" note="Every semantic role, at rest and disabled.">
        <Panel>
          <div className="ui-action-row" data-harness="buttons">
            <button type="button" className="ui-btn ui-btn-primary" data-role="primary">Primary action</button>
            <button type="button" className="ui-btn ui-btn-secondary" data-role="secondary">Secondary action</button>
            <button type="button" className="ui-btn ui-btn-ghost" data-role="ghost">Quiet action</button>
            <button type="button" className="ui-btn ui-btn-danger" data-role="danger">Delete</button>
            <button type="button" className="ui-btn ui-btn-primary" disabled data-role="primary-disabled">Disabled</button>
            <a href="#buttons" className="catalog-action-primary ui-btn" data-role="catalog-primary">Add to cart</a>
            <a href="#buttons" className="catalog-action-secondary ui-btn" data-role="catalog-secondary">Start a custom project</a>
          </div>
        </Panel>
      </Group>

      {/* ---------------- Badges ---------------- */}
      <Group id="badges" title="Badges" note="Semantic tones. Accent follows the Appearance badge controls; status tones are fixed.">
        <Panel>
          <div className="flex flex-wrap items-center gap-2" data-harness="badges">
            <Badge data-tone="neutral">Neutral</Badge>
            <Badge tone="accent" data-tone="accent">Customizable</Badge>
            <Badge tone="success" data-tone="success">Active</Badge>
            <Badge tone="warning" data-tone="warning">1 left</Badge>
            <Badge tone="danger" data-tone="danger">Out of stock</Badge>
          </div>
        </Panel>
      </Group>

      {/* ---------------- Product cards ---------------- */}
      <Group id="product-cards" title="Storefront product cards" note="The Buy now call-to-action lives here.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-harness="product-cards">
          {productFixtures.map(product => (
            <ProductCard key={product.id} product={product} showWishlist={false} />
          ))}
        </div>
      </Group>

      {/* ---------------- Staff rows ---------------- */}
      <Group id="staff-rows" title="Staff catalog rows" note="Rendered at full width and inside the 380px editor column.">
        <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <div className="staff-rows" data-harness="staff-rows-narrow">
              {staffCatalogFixtures.map(product => (
                <StaffCatalogRow key={product.id} product={product} />
              ))}
            </div>
          </div>
          <div className="min-w-0">
            <div className="staff-rows" data-harness="staff-rows-wide">
              {staffCatalogFixtures.map(product => (
                <StaffCatalogRow key={`w-${product.id}`} product={product} />
              ))}
            </div>
          </div>
        </div>
      </Group>

      {/* ---------------- Forms ---------------- */}
      <Group id="forms" title="Form controls">
        <Panel>
          <div className="staff-form-grid" data-harness="forms">
            <Field label="Product name" required help="Shown to customers on the catalog.">
              <input className="ui-input" defaultValue="Billet Shift Knob" />
            </Field>
            <Field label="SKU">
              <input className="ui-input" placeholder="KM-0000" />
            </Field>
            <Field label="Description" className="staff-form-wide">
              <textarea className="ui-input" rows={3} defaultValue="Turned from 6061 aluminum." />
            </Field>
            <Field label="Native select">
              <select defaultValue="active">
                <option value="active">Active</option>
                <option value="draft">Draft</option>
              </select>
            </Field>
            <Field label="Disabled field">
              <input className="ui-input" defaultValue="Read only" disabled />
            </Field>
            <label className="staff-check staff-form-wide">
              <input type="checkbox" defaultChecked />
              <span className="staff-check-text">
                Customizable only
                <span className="staff-check-help">Restrict the list to products that accept options.</span>
              </span>
            </label>
          </div>
        </Panel>
      </Group>

      {/* ---------------- Surfaces & states ---------------- */}
      <Group id="states" title="Metrics, notices, and states">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-harness="metrics">
          <MetricCard label="Open orders" value="18" detail="4 awaiting payment" />
          <MetricCard label="Low stock" value="3" detail="Reorder soon" tone="warning" />
          <MetricCard label="Failed jobs" value="1" detail="Needs attention" tone="danger" />
          <MetricCard label="Shipped" value="42" detail="Last 30 days" tone="success" />
        </div>
        <div className="grid gap-3" data-harness="notices">
          <Notice tone="info">An informational notice.</Notice>
          <Notice tone="warning">A warning notice.</Notice>
          <Notice tone="danger">Products are not shown because the catalog could not be loaded.</Notice>
          <Notice tone="success">Saved.</Notice>
        </div>
        <EmptyState data-harness="empty">No products match this view.</EmptyState>
      </Group>

      {/* The page-level surfaces: each route's actual composition. */}
      <StaffSurfaces />
    </div>
  );
}

function StaffCatalogRow({ product }: { product: (typeof staffCatalogFixtures)[number] }) {
  return (
    <button type="button" className="staff-row" data-harness-row={product.id}>
      <span className="staff-row-media" aria-hidden="true" />
      <span className="staff-row-main">
        <span className="staff-row-title block">{product.name}</span>
        <span className="staff-row-detail block">
          {product.sku ? `${product.sku} · ` : ""}
          {product.category}
        </span>
      </span>
      <span className="staff-row-figure">{money(product.priceCents)}</span>
      <span className="staff-row-aside">
        {product.stock === "low_stock" ? <Badge tone="warning">{product.quantity} left</Badge> : null}
        {product.stock === "out_of_stock" ? <Badge tone="danger">Out of stock</Badge> : null}
        <Badge tone={product.status === "active" ? "success" : "neutral"}>
          {product.status === "active" ? "Active" : product.status === "hidden" ? "Hidden" : "Draft"}
        </Badge>
      </span>
    </button>
  );
}
