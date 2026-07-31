import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/siteSettings";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return { title: `Privacy Policy | ${settings.name}` };
}

export default async function PrivacyPage() {
  const siteSettings = await getSiteSettings();
  return (
    <main className="flex justify-center px-4 py-16">
      <article className="w-full max-w-3xl text-center space-y-10">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground">
            Last updated: December 7, 2025
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Overview</h2>
          <p>
            This Privacy Policy explains how <strong>{siteSettings.name}</strong>{" "}
            (&quot;Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;)
            collects, uses, and shares information when you use our website, forum,
            and related services (collectively, the &ldquo;Services&rdquo;).
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Information We Collect</h2>
          <ul className="list-disc list-inside space-y-1 text-left mx-auto max-w-xl">
            <li>
              <strong>Account data:</strong> e.g. email address, username, profile
              information you provide
            </li>
            <li>
              <strong>Content you submit:</strong> posts, comments, uploads, messages
              (if applicable)
            </li>
            <li>
              <strong>Usage data:</strong> pages viewed, actions taken, approximate
              location, device/browser info
            </li>
            <li>
              <strong>Cookies:</strong> for authentication, preferences, and analytics
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">How We Use Information</h2>
          <ul className="list-disc list-inside space-y-1 text-left mx-auto max-w-xl">
            <li>Provide and maintain the Services</li>
            <li>Authenticate users and prevent fraud/abuse</li>
            <li>Moderate content and enforce rules</li>
            <li>Improve features, performance, and user experience</li>
            <li>Communicate important service or policy updates</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Sharing of Information</h2>
          <p>
            We may share information with service providers that help operate the
            Services (e.g. hosting, analytics, authentication), and when required
            to comply with law or to protect the safety and rights of users and
            the public.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Your Choices</h2>
          <ul className="list-disc list-inside space-y-1 text-left mx-auto max-w-xl">
            <li>You can update certain profile information in your account settings</li>
            <li>You can manage cookies through your browser settings</li>
            <li>You may request account deletion (subject to legal/abuse-prevention needs)</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Data Retention</h2>
          <p>
            We retain information as long as necessary to operate the Services,
            comply with legal obligations, resolve disputes, and enforce agreements.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Security</h2>
          <p>
            We use reasonable administrative, technical, and organizational measures
            to protect information. However, no method of transmission or storage
            is completely secure.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Children</h2>
          <p>
            The Services are not directed to children under 13, and we do not
            knowingly collect personal information from children under 13.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. Updates will be
            posted on this page with an updated &ldquo;Last updated&rdquo; date.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Contact</h2>
          <p>
            Questions? Contact us at{" "}
            <a
              href="mailto:schassisresourcearchive@gmail.com"
              className="underline"
            >
              schassisresourcearchive@gmail.com
            </a>
            .
          </p>
        </section>
      </article>
    </main>
  );
}
