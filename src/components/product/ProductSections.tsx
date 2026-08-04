import type { ProductSection } from "@/lib/commerce/productContent";

/**
 * The structured product information below the fold.
 *
 * Built on native `<details>`/`<summary>`. That is not a shortcut — it is the
 * only version of this control that works before hydration, gives keyboard
 * operation (Enter and Space) and the correct expanded state to a screen reader
 * without a line of ARIA, and survives JavaScript failing to load. A hand-built
 * accordion here would be a client component, a `useState`, four ARIA
 * attributes and a keyboard handler to arrive at what the browser already does.
 *
 * Every section carries a stable `id`, so `/catalog/x#specifications` links
 * straight to one. `:target` in `globals.css` opens the targeted section, which
 * means a deep link works without JavaScript deciding anything.
 *
 * Sections arrive pre-filtered by `buildProductSections`; anything without
 * content never reaches this component. There is deliberately no "no
 * information available" placeholder — a sparse product simply has fewer
 * sections, which reads as a short page rather than a broken one.
 *
 * All values render as text. Nothing here is `dangerouslySetInnerHTML`, so
 * staff-entered content cannot inject markup; newlines survive through
 * `white-space: pre-line` rather than by splitting into elements.
 */
export default function ProductSections({ sections }: { sections: ProductSection[] }) {
  if (!sections.length) return null;

  return (
    <section className="product-sections" aria-labelledby="product-details-heading">
      <h2 id="product-details-heading" className="product-sections-heading">
        Product details
      </h2>

      <div className="product-sections-list">
        {sections.map((section, index) => (
          <details
            key={section.id}
            id={section.id}
            className="product-section"
            // The first section is open so the page does not present as a
            // stack of closed drawers with nothing to read.
            open={index === 0}
          >
            <summary className="product-section-summary">
              <h3 className="product-section-title">{section.title}</h3>
              <span className="product-section-marker" aria-hidden="true" />
            </summary>

            <div className="product-section-body">
              {section.body ? <p className="product-section-prose">{section.body}</p> : null}

              {section.benefits?.length ? (
                <ul className="product-benefit-list">
                  {section.benefits.map((benefit) => (
                    <li key={benefit.title || benefit.body} className="product-benefit">
                      {benefit.title ? <p className="product-benefit-title">{benefit.title}</p> : null}
                      {benefit.body ? <p className="product-benefit-body">{benefit.body}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {section.specs?.length ? (
                /* A description list, not a table: these are name/value pairs
                   with no column relationship between rows, and `<dl>` reflows
                   to a single column on a phone without a horizontal scroller. */
                <dl className="product-spec-list">
                  {section.specs.map((spec) => (
                    <div key={`${spec.name}-${spec.value}`} className="product-spec-row">
                      <dt className="product-spec-name">{spec.name}</dt>
                      <dd className="product-spec-value">{spec.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {section.entries?.length ? (
                <ul className="product-entry-list">
                  {section.entries.map((entry) => (
                    <li key={entry.value} className="product-entry">
                      <span className="product-entry-value">{entry.value}</span>
                      {entry.note ? <span className="product-entry-note">{entry.note}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {section.faq?.length ? (
                <div className="product-faq-list">
                  {section.faq.map((item) => (
                    <div key={item.title || item.body} className="product-faq-item">
                      {item.title ? <p className="product-faq-question">{item.title}</p> : null}
                      {item.body ? <p className="product-faq-answer">{item.body}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
