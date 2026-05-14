import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import SignaturePad from './SignaturePad.jsx';

// Full condition checklist matching the Client Intake Form – Therapeutic Massage
const CONDITIONS = [
  { key: 'areas_of_swelling',     label: 'Areas of swelling' },
  { key: 'autoimmune_disorder',   label: 'Autoimmune disorder' },
  { key: 'back_neck_problems',    label: 'Back / neck problems' },
  { key: 'bleeding_disorders',    label: 'Bleeding disorders' },
  { key: 'blood_clots',           label: 'Blood clots' },
  { key: 'bruise_easily',         label: 'Bruise easily' },
  { key: 'bursitis',              label: 'Bursitis' },
  { key: 'cancer',                label: 'Cancer' },
  { key: 'contagious_condition',  label: 'Contagious condition' },
  { key: 'decreased_sensation',   label: 'Decreased sensation' },
  { key: 'diabetes',              label: 'Diabetes' },
  { key: 'fibromyalgia',          label: 'Fibromyalgia' },
  { key: 'headaches',             label: 'Headaches' },
  { key: 'heart_condition',       label: 'Heart condition' },
  { key: 'hypertension',          label: 'Hypertension' },
  { key: 'kidney_disease',        label: 'Kidney disease' },
  { key: 'multiple_sclerosis',    label: 'Multiple sclerosis' },
  { key: 'neurological_condition',label: 'Neurological condition' },
  { key: 'neuropathy',            label: 'Neuropathy' },
  { key: 'osteoarthritis',        label: 'Osteoarthritis' },
  { key: 'osteoporosis',          label: 'Osteoporosis' },
  { key: 'phlebitis',             label: 'Phlebitis' },
  { key: 'sciatica',              label: 'Sciatica' },
  { key: 'seizures',              label: 'Seizures / Epilepsy' },
  { key: 'skin_condition',        label: 'Skin condition' },
  { key: 'stroke',                label: 'Stroke' },
  { key: 'tendinitis',            label: 'Tendinitis' },
  { key: 'tmj_disorder',          label: 'TMJ disorder' },
  { key: 'varicose_veins',        label: 'Varicose veins' },
  { key: 'vertigo_dizziness',     label: 'Vertigo / dizziness' },
];

const BLANK = {
  // existing
  pregnancy: false, heart_condition: false, blood_pressure: 'none',
  diabetes: false, epilepsy: false, cancer: false, dvt: false,
  recent_surgery: false, bone_fracture: false, skin_condition: false,
  varicose_veins: false, osteoporosis: false, lymphoedema: false,
  medications: '', allergies: '', areas_to_avoid: '', skin_conditions_detail: '',
  // new conditions
  areas_of_swelling: false, autoimmune_disorder: false, back_neck_problems: false,
  bleeding_disorders: false, blood_clots: false, bruise_easily: false,
  bursitis: false, contagious_condition: false, decreased_sensation: false,
  fibromyalgia: false, headaches: false, hypertension: false,
  kidney_disease: false, multiple_sclerosis: false, neurological_condition: false,
  neuropathy: false, osteoarthritis: false, phlebitis: false,
  sciatica: false, seizures: false, stroke: false, tendinitis: false,
  tmj_disorder: false, vertigo_dizziness: false,
  // new detail fields
  pregnancy_months: '', pregnancy_due_date: '',
  under_medical_supervision: false, medical_supervision_detail: '',
  broken_skin: false, broken_skin_where: '',
  joint_replacement: false, joint_replacement_detail: '',
  recent_injuries_yn: false, recent_injuries_detail: '',
  other_conditions: '',
  // massage info
  had_massage_before: false, massage_recency: '',
  reason_for_massage: '', pressure_preference: '',
};

const row = { display: 'flex', gap: 8, alignItems: 'center' };
const yesNo = (val, onChange) => (
  <div style={row}>
    <label style={row}><input type="radio" name={Math.random()} style={{ width: 'auto' }} checked={val === true}  onChange={() => onChange(true)}  /> Yes</label>
    <label style={row}><input type="radio" name={Math.random()} style={{ width: 'auto' }} checked={val === false} onChange={() => onChange(false)} /> No</label>
  </div>
);

export default function MedicalQuestionnaireForm({ clientId, initial, onSaved }) {
  const [m, setM]     = useState({ ...BLANK, ...(initial || {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sigRef = useRef(null);

  function set(k, v) { setM((s) => ({ ...s, [k]: v })); }

  async function save() {
    setBusy(true); setError('');
    try {
      const sig = sigRef.current?.getDataURL() || initial?.digital_signature || null;
      const body = { ...m, digital_signature: sig };
      const r = await api.put(`/clients/${clientId}/medical`, body);
      onSaved?.(r.medical);
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  const flagged = CONDITIONS.filter((f) => m[f.key]);

  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Client Intake Form — Therapeutic Massage</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Please complete before your first treatment. All information is confidential.
        </p>

        {/* ── Health Information ─────────────────────────────────── */}
        <h4 style={{ marginBottom: 4 }}>Health Information</h4>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'center' }}>

          {/* Medications */}
          <span>Are you taking any medications?</span>
          {yesNo(!!m.medications, (v) => set('medications', v ? m.medications || ' ' : ''))}
          {m.medications && m.medications.trim() !== '' && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>If yes, please list:</span>
              <input value={m.medications} onChange={(e) => set('medications', e.target.value)} />
            </>
          )}

          {/* Allergies */}
          <span>Any allergies? (oils, lotions, nuts, fruits, skin, etc.)</span>
          {yesNo(!!m.allergies, (v) => set('allergies', v ? m.allergies || ' ' : ''))}
          {m.allergies && m.allergies.trim() !== '' && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>If yes, please list:</span>
              <input value={m.allergies} onChange={(e) => set('allergies', e.target.value)} />
            </>
          )}

          {/* Pregnancy */}
          <span>Are you pregnant?</span>
          {yesNo(m.pregnancy, (v) => set('pregnancy', v))}
          {m.pregnancy && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>How many months?</span>
              <input placeholder="e.g. 3" value={m.pregnancy_months || ''} onChange={(e) => set('pregnancy_months', e.target.value)} />
              <span className="muted" style={{ fontSize: 12 }}>Due date:</span>
              <input type="date" value={m.pregnancy_due_date || ''} onChange={(e) => set('pregnancy_due_date', e.target.value)} />
            </>
          )}

          {/* Medical supervision */}
          <span>Are you currently under medical supervision or receiving other medical interventions?</span>
          {yesNo(m.under_medical_supervision, (v) => set('under_medical_supervision', v))}
          {m.under_medical_supervision && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>If yes, please describe:</span>
              <input value={m.medical_supervision_detail || ''} onChange={(e) => set('medical_supervision_detail', e.target.value)} />
            </>
          )}
        </div>

        {/* ── Conditions checklist ───────────────────────────────── */}
        <h4 style={{ margin: '12px 0 4px' }}>Please tick any conditions that apply:</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {CONDITIONS.map((f) => (
            <label key={f.key} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={!!m[f.key]}
                onChange={(e) => set(f.key, e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>{f.label}</span>
            </label>
          ))}
        </div>

        {m.skin_condition && (
          <div style={{ marginTop: 6 }}>
            <label>Skin condition details</label>
            <textarea rows={2} value={m.skin_conditions_detail || ''} onChange={(e) => set('skin_conditions_detail', e.target.value)} />
          </div>
        )}

        {/* ── Additional questions ───────────────────────────────── */}
        <h4 style={{ margin: '12px 0 4px' }}>Additional Questions</h4>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'center' }}>

          {/* Broken skin */}
          <span>Areas of broken skin? (e.g. rash, wounds)</span>
          {yesNo(m.broken_skin, (v) => set('broken_skin', v))}
          {m.broken_skin && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>If yes, where?</span>
              <input value={m.broken_skin_where || ''} onChange={(e) => set('broken_skin_where', e.target.value)} />
            </>
          )}

          {/* Joint replacement */}
          <span>History of joint replacement surgery?</span>
          {yesNo(m.joint_replacement, (v) => set('joint_replacement', v))}
          {m.joint_replacement && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>Which joint(s)?</span>
              <input value={m.joint_replacement_detail || ''} onChange={(e) => set('joint_replacement_detail', e.target.value)} />
            </>
          )}

          {/* Recent injuries */}
          <span>Recent injuries or medical procedures in the past 2 years?</span>
          {yesNo(m.recent_injuries_yn, (v) => set('recent_injuries_yn', v))}
          {m.recent_injuries_yn && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>Please describe:</span>
              <input value={m.recent_injuries_detail || ''} onChange={(e) => set('recent_injuries_detail', e.target.value)} />
            </>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Please describe any other injuries or health conditions</label>
          <textarea rows={2} value={m.other_conditions || ''} onChange={(e) => set('other_conditions', e.target.value)} />
        </div>

        {/* ── Massage Information ────────────────────────────────── */}
        <h4 style={{ margin: '12px 0 4px' }}>Massage Information</h4>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'center' }}>
          <span>Have you had professional massage before?</span>
          {yesNo(m.had_massage_before, (v) => set('had_massage_before', v))}
          {m.had_massage_before && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>How recently?</span>
              <input value={m.massage_recency || ''} onChange={(e) => set('massage_recency', e.target.value)} />
            </>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Reason for seeking massage</label>
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            {['Relaxation', 'Specific problem'].map((opt) => (
              <label key={opt} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="radio"
                  style={{ width: 'auto' }}
                  checked={m.reason_for_massage === opt}
                  onChange={() => set('reason_for_massage', opt)}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <label>How much pressure do you prefer?</label>
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            {['Light', 'Medium', 'Firm'].map((opt) => (
              <label key={opt} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="radio"
                  style={{ width: 'auto' }}
                  checked={m.pressure_preference === opt}
                  onChange={() => set('pressure_preference', opt)}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Areas to avoid</label>
          <textarea rows={2} value={m.areas_to_avoid || ''} onChange={(e) => set('areas_to_avoid', e.target.value)} />
        </div>

        {/* ── Therapist alert ────────────────────────────────────── */}
        {flagged.length > 0 && (
          <div className="card" style={{ background: '#fef3c7', borderColor: '#fcd34d', padding: 10, marginTop: 8 }}>
            <strong>⚠ Therapist review required.</strong> Flagged: {flagged.map((f) => f.label).join(', ')}.
          </div>
        )}

        {/* ── Signature ─────────────────────────────────────────── */}
        <div style={{ marginTop: 12 }}>
          <label>Client signature</label>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            By signing below, I acknowledge that I am aware of the benefits and risks of massage therapy
            and that I have completed this form to the best of my knowledge. I also agree to inform my
            massage therapist of any health or medical changes.
          </p>
          <SignaturePad ref={sigRef} initialDataUrl={initial?.digital_signature} />
          <div className="row" style={{ marginTop: 6, justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12 }}>
              I confirm the above is accurate to the best of my knowledge.
            </span>
            <button onClick={() => sigRef.current?.clear()}>Clear</button>
          </div>
        </div>

        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        {initial?.updated_at && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Last updated {new Date(initial.updated_at).toLocaleString('en-GB')}
            {initial.signed_at && ` · Signed ${new Date(initial.signed_at).toLocaleString('en-GB')}`}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save questionnaire'}
          </button>
        </div>
      </div>
    </div>
  );
}
