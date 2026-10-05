'use client';

import Link from 'next/link';
import { PSIRA_GRADES } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useLoad } from '@/components/ui';

/**
 * The blank enrolment form to print (owner, 5 Oct 2026). The new guard fills in sections 1 to 7
 * by hand; the person enrolling him completes section 8 and then captures everything on the
 * Enrol officer screen, which follows the same order. Sites and shift patterns are the company's
 * own, so they can be ticked.
 */
export default function EnrolmentFormPage() {
  const { me } = useSession();
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const patterns = useLoad(() => api<{ id: string; code: string; name: string; description: string; active: boolean }[]>('/roster/patterns'));

  return (
    <>
      <div className="head no-print">
        <div>
          <Link href="/officers" className="mute small">
            ← Officers
          </Link>
          <h1>Blank enrolment form</h1>
          <p className="mute">
            Print it for a new guard to fill in by hand (sections 1 to 7). Whoever enrols him completes section 8 and then
            captures it all under <b>Officers, Enrol officer</b>, in the same order. Two A4 pages.
          </p>
        </div>
        <button className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      <div className="eform">
        <header className="eform-head">
          <img src="/tsf-logo.png" alt="The Security Franchise" />
          <div>
            <h2>Employee enrolment form</h2>
            <div>{me.company.name} · On Par</div>
          </div>
          <div className="eform-ref">
            Form date: <span className="eline short" />
          </div>
        </header>
        <p className="eform-note">Please write clearly in CAPITAL LETTERS. Fields marked * are required.</p>

        <section>
          <h3>1. Personal details</h3>
          <Line label="Full names *" />
          <Line label="Surname *" />
          <Boxes label="SA ID number *" count={13} />
          <div className="eform-row">
            <Boxes label="Cell number *" count={10} />
            <Line label="Home language" />
          </div>
          <Line label="Home address: street and number" />
          <div className="eform-row">
            <Line label="Suburb" />
            <Line label="Town or city" />
            <Line label="Postal code" short />
          </div>
        </section>

        <section>
          <h3>2. Next of kin (who we call in an emergency)</h3>
          <div className="eform-row">
            <Line label="Name and surname *" />
            <Line label="Relationship (e.g. wife, brother)" />
          </div>
          <Boxes label="Cell number *" count={10} />
        </section>

        <section>
          <h3>3. PSIRA registration</h3>
          <div className="eform-row">
            <Line label="PSIRA number *" />
            <Ticks label="Grade *" options={[...PSIRA_GRADES]} />
            <Line label="Expiry date *  (DD/MM/YYYY)" />
          </div>
        </section>

        <section>
          <h3>4. Qualifications and training (attach a copy of each certificate)</h3>
          <table className="eform-table">
            <thead>
              <tr>
                <th>Course or qualification (e.g. firearm competency, first aid)</th>
                <th>Date completed</th>
                <th>Expiry date</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4].map((i) => (
                <tr key={i}>
                  <td />
                  <td />
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>5. Uniform sizes</h3>
          <div className="eform-row">
            <Line label="Shirt" short />
            <Line label="Trousers (waist)" short />
            <Line label="Boots" short />
            <Line label="Jacket" short />
            <Line label="Cap" short />
          </div>
        </section>

        <section className="eform-break">
          <h3>6. Photos and copies (taken or scanned at enrolment)</h3>
          <p className="small">The person enrolling you takes or receives these four. Tick when done.</p>
          <div className="eform-row">
            <Ticks options={['Face close-up', 'Full body in uniform', 'ID document', 'PSIRA card']} />
          </div>
        </section>

        <section>
          <h3>7. Declaration and consent</h3>
          <ul className="eform-list">
            <li>The information on this form is true and complete.</li>
            <li>
              I agree that The Security Franchise keeps my details and photos in On Par for my employment, and uses my
              photo on my ID badge and to check that it is me when I go on duty (my selfie at Duty On may be compared with
              my enrolment photo).
            </li>
            <li>I will tell the company if my address, cell number, next of kin or PSIRA details change.</li>
          </ul>
          <div className="eform-row eform-sign">
            <Line label="Signature" />
            <Line label="Date" short />
          </div>
        </section>

        <section className="eform-office">
          <h3>8. Office use only</h3>
          <div className="eform-row">
            <Line label="Employee number (leave blank and On Par gives one)" />
            <Line label="Start date" short />
          </div>
          <div className="eform-label">Home site *</div>
          <Ticks options={sites.data?.map((s) => s.name) ?? []} other />
          <div className="eform-label" style={{ marginTop: 8 }}>
            Shift pattern *
          </div>
          <Ticks options={patterns.data?.filter((p) => p.active).map((p) => `${p.code} ${p.name}${p.description && p.description !== p.name ? ` (${p.description})` : ''}`) ?? []} other />
          <div className="eform-row" style={{ marginTop: 8 }}>
            <Line label="Pattern starts on (date)" short />
            <Line label="Position in the pattern (day number)" short />
            <Ticks label="First shift" options={['Day', 'Night']} />
          </div>
          <table className="eform-table">
            <thead>
              <tr>
                <th>Kit issued (e.g. radio, torch, baton)</th>
                <th>Size</th>
                <th>Serial or asset number</th>
                <th>Date issued</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3].map((i) => (
                <tr key={i}>
                  <td />
                  <td />
                  <td />
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
          <div className="eform-row">
            <Line label="Enrolled by (name)" />
            <Line label="Signature" />
            <Line label="Captured on On Par (date)" short />
          </div>
          <p className="small" style={{ marginBottom: 0 }}>
            Once captured, On Par issues the guard&apos;s TSF number, ID badge and first PIN.
          </p>
        </section>
      </div>
    </>
  );
}

function Line({ label, short }: { label: string; short?: boolean }) {
  return (
    <div className={`eform-field${short ? ' short' : ''}`}>
      <div className="eform-label">{label}</div>
      <div className="eline" />
    </div>
  );
}

function Boxes({ label, count }: { label: string; count: number }) {
  return (
    <div className="eform-field">
      <div className="eform-label">{label}</div>
      <div className="eform-boxes">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

function Ticks({ label, options, other }: { label?: string; options: string[]; other?: boolean }) {
  return (
    <div className="eform-field">
      {label && <div className="eform-label">{label}</div>}
      <div className="eform-ticks">
        {options.map((o) => (
          <span key={o}>
            <i /> {o}
          </span>
        ))}
        {other && (
          <span>
            <i /> Other: <span className="eline inline" />
          </span>
        )}
      </div>
    </div>
  );
}
