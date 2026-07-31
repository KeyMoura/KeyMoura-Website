import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/siteSettings";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return { title: `Terms of Service | ${settings.name}` };
}

export default async function TermsPage() {
  const siteSettings = await getSiteSettings();
  return (
    <main className="flex justify-center px-4 py-16">
      <article className="w-full max-w-3xl text-center space-y-10">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Terms and Conditions</h1>
          <p className="text-sm text-muted-foreground">
            Last updated: July 31, 2026
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">
            Agreement to Our Legal Terms
          </h2>
          <p>
            We are <strong>{siteSettings.name}</strong> (&quot;Company&quot;,
            &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;). We operate a
            custom-product storefront, order workspace, community, and related
            services (collectively, the
            &ldquo;Services&rdquo;).
          </p>
          <p>
            By accessing or using the Services, you agree that you have read,
            understood, and agree to be bound by these Terms and Conditions
            (&ldquo;Legal Terms&rdquo;). If you do not agree, you must discontinue
            use immediately.
          </p>
          <p>
            The Services are intended for users who are at least{" "}
            <strong>16 years old</strong>. If you are a minor in your
            jurisdiction, you must have permission and supervision from a parent
            or legal guardian.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">1. Our Services</h2>
          <p>
            {siteSettings.name} provides custom-product requests, order messaging,
            secure payment, technical information, and community features.
          </p>
          <p>
            All information is provided for informational purposes only and
            should not be considered professional engineering, legal, or safety
            advice.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">
            2. Intellectual Property Rights
          </h2>
          <p>
            Unless otherwise stated, the Services and all original content,
            branding, logos, and design elements are owned by or licensed to us.
          </p>
          <p>
            You are granted a limited, non-exclusive, non-transferable license to
            access and use the Services for personal, non-commercial purposes.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">3. User Representations</h2>
          <ul className="list-disc list-inside space-y-1 text-left mx-auto max-w-xl">
            <li>You will comply with all applicable laws</li>
            <li>You will not submit false or misleading content</li>
            <li>You will not impersonate another person or entity</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">4. User Registration</h2>
          <p>
            You may be required to register an account. You are responsible for
            maintaining the confidentiality of your account credentials and all
            activity under your account.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">5. Prohibited Activities</h2>
          <ul className="list-disc list-inside space-y-1 text-left mx-auto max-w-xl">
            <li>Harassment, abuse, or threats</li>
            <li>Spamming or advertising without permission</li>
            <li>Automated scraping or data extraction</li>
            <li>Uploading malware or malicious code</li>
            <li>Attempting to bypass moderation or security systems</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">6. User Generated Content</h2>
          <p>
            You retain ownership of content you submit, but grant us a worldwide,
            royalty-free license to host, display, and distribute that content as
            part of operating the Services.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">10. Advertisers</h2>
          <p>
            We are not responsible for the accuracy, legality, or safety of
            third-party advertisements or external links.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">14. Term and Termination</h2>
          <p>
            These Terms remain in effect while you use the Services. We reserve
            the right to suspend or terminate access at any time.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">19. Disclaimer</h2>
          <p className="uppercase text-sm">
            The Services are provided &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo; without warranties of any kind.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">20. Limitation of Liability</h2>
          <p>
            In no event shall we be liable for indirect, incidental, or
            consequential damages arising from your use of the Services.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Contact</h2>
          <p>
            For copyright or legal concerns, contact us at{" "}
            <a
              href="mailto:support@keymoura.com"
              className="underline"
            >
              support@keymoura.com
            </a>
          </p>
        </section>
      </article>
    </main>
  );
}
