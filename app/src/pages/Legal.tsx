import { useState } from "react";

const CONTACT_EMAIL = "jovenandrei0324@gmail.com";
const LAST_UPDATED = "August 10, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-5 mt-5 border-t border-neutral-800 first:pt-0 first:mt-0 first:border-t-0">
      <h2 className="text-sm font-semibold text-neutral-200 mb-1.5">{title}</h2>
      <p className="text-sm text-neutral-400 leading-relaxed">{children}</p>
    </div>
  );
}

function TermsContent() {
  return (
    <>
      <Section title="1. About ClipFlow">
        ClipFlow is a desktop application that helps a user turn long-form video into
        short-form clips, apply a visual template (crop, watermark, captions), and prepare
        them for posting to social platforms such as TikTok. ClipFlow runs locally on the
        user's own computer.
      </Section>
      <Section title="2. Acceptable use">
        You agree to use ClipFlow only with video content you own or otherwise have the
        legal right to edit and publish, and to comply with the terms of service of any
        platform (including TikTok) you connect ClipFlow to or publish content through.
      </Section>
      <Section title="3. No warranty">
        ClipFlow is provided "as is," without warranty of any kind. We do not guarantee
        that generated clips, captions, or automated posts will be accurate, error-free, or
        accepted by any third-party platform.
      </Section>
      <Section title="4. Limitation of liability">
        To the fullest extent permitted by law, ClipFlow's developer is not liable for any
        indirect, incidental, or consequential damages arising from use of the application,
        including issues with third-party platform accounts.
      </Section>
      <Section title="5. Third-party platforms">
        When you connect a third-party account (such as TikTok, YouTube, or Facebook) to
        ClipFlow, your use of that platform remains governed by that platform's own terms of
        service. ClipFlow is not responsible for actions taken by a third-party platform,
        including rejecting, removing, or restricting content you publish through it.
      </Section>
      <Section title="6. Termination">
        You may stop using ClipFlow and disconnect any linked accounts at any time by
        removing them from the Accounts page or uninstalling the application. We may
        discontinue or modify ClipFlow at any time.
      </Section>
      <Section title="7. Eligibility">
        You must be old enough to form a binding contract in your jurisdiction, and to hold
        an account on any third-party platform you connect to ClipFlow, to use this
        application.
      </Section>
      <Section title="8. Governing law">
        These terms are governed by the laws of the Republic of the Philippines, without
        regard to conflict-of-law principles.
      </Section>
      <Section title="9. Changes">
        These terms may be updated from time to time. Continued use of ClipFlow after a
        change constitutes acceptance of the revised terms.
      </Section>
      <Section title="10. Contact">
        Questions about these terms can be sent to{" "}
        <a className="text-blue-400 hover:text-blue-300 underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        .
      </Section>
    </>
  );
}

function PrivacyContent() {
  return (
    <>
      <Section title="1. Data processed locally">
        ClipFlow processes your video files, transcripts, and generated captions locally on
        your device in a local SQLite database. This data is not uploaded to any server
        operated by ClipFlow's developer.
      </Section>
      <Section title="2. Third-party AI processing">
        To generate captions and clip suggestions, ClipFlow sends transcript excerpts to a
        third-party AI service on your behalf, from your own device. No video files are
        uploaded for this purpose — only text.
      </Section>
      <Section title="3. Platform credentials">
        If you connect a social media account (e.g. TikTok) to ClipFlow to enable posting,
        any account credentials or tokens are stored locally on your device and are used
        only to publish content you explicitly choose to post.
      </Section>
      <Section title="4. No sale of data">
        We do not sell, rent, or share your data with third parties for advertising or
        marketing purposes.
      </Section>
      <Section title="5. Data deletion">
        Since all data is stored locally, you can delete it at any time by removing
        ClipFlow's application data folder or uninstalling the application.
      </Section>
      <Section title="6. What we don't collect">
        ClipFlow's developer does not operate a server that stores your video files,
        transcripts, or rendered clips. We do not use analytics or advertising trackers
        inside the application.
      </Section>
      <Section title="7. Data retention">
        Locally stored data (videos, transcripts, captions, and account tokens) persists on
        your device until you delete it yourself — either through the app or by removing its
        application data folder — since there is no ClipFlow-operated server copy to retain
        or expire.
      </Section>
      <Section title="8. Children's privacy">
        ClipFlow is not directed at children under 13, and we do not knowingly process data
        from children under that age.
      </Section>
      <Section title="9. Changes to this policy">
        We may update this Privacy Policy from time to time. Material changes will be
        reflected by updating the "Last updated" date above.
      </Section>
      <Section title="10. Contact">
        Questions about this policy can be sent to{" "}
        <a className="text-blue-400 hover:text-blue-300 underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        .
      </Section>
    </>
  );
}

export default function Legal() {
  const [tab, setTab] = useState<"terms" | "privacy">("terms");

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Legal</h1>
        <p className="text-xs text-neutral-500 mb-6">
          Same content as{" "}
          <a
            className="underline"
            href={`https://clipflow24.netlify.app/${tab}`}
            target="_blank"
            rel="noreferrer"
          >
            clipflow24.netlify.app/{tab}
          </a>
          .
        </p>

        <div className="flex gap-1 mb-6 border-b border-neutral-800">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === "terms" ? "border-blue-500 text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => setTab("terms")}
          >
            Terms of Service
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === "privacy" ? "border-blue-500 text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => setTab("privacy")}
          >
            Privacy Policy
          </button>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
          <h2 className="text-lg font-semibold">{tab === "terms" ? "Terms of Service" : "Privacy Policy"}</h2>
          <p className="text-xs text-neutral-500 mb-1">Last updated: {LAST_UPDATED}</p>
          {tab === "terms" ? <TermsContent /> : <PrivacyContent />}
        </div>
      </div>
    </div>
  );
}
