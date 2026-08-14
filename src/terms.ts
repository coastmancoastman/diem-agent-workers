import type { AppConfig } from "./config.js";
import { SERVICE_VERSION } from "./constants.js";

export const TERMS_EFFECTIVE_DATE = "2026-08-14";
export const VENICE_TERMS_URL = "https://venice.ai/legal/tos";

export function termsDocument(config: AppConfig) {
  const termsUrl = `${config.publicBaseUrl}/terms`;
  return {
    service: "DIEM Agent Workers",
    version: SERVICE_VERSION,
    effectiveDate: TERMS_EFFECTIVE_DATE,
    termsUrl,
    operator: {
      name: "DIEM Agent Workers project",
      identity: "https://github.com/coastmancoastman/diem-agent-workers",
      contact: "https://github.com/coastmancoastman/diem-agent-workers/security/advisories/new",
    },
    acceptance:
      "By accessing, paying for, or using this service, the caller and the person or organization operating it agree to these terms.",
    upstreamTerms: [
      {
        provider: "Venice.ai",
        url: VENICE_TERMS_URL,
        requirement:
          "Callers and their operators must comply with applicable Venice.ai terms and the policies of the selected model provider.",
      },
    ],
    prohibitedUses: [
      "unlawful, fraudulent, abusive, exploitative, or excessive use",
      "child sexual abuse or exploitation content or conduct",
      "infringement, privacy invasion, impersonation, harassment, or defamation",
      "malware, credential theft, unauthorized system access, or service interference",
      "high-stakes uses where model failure could cause death, serious injury, or significant physical, financial, or safety harm",
      "submission of credentials, authentication tokens, private keys, seed phrases, or data the caller lacks authority to process",
    ],
    outputTerms: {
      accuracy:
        "Outputs may be inaccurate, incomplete, offensive, or unsuitable even when they satisfy a JSON schema.",
      professionalAdvice:
        "Outputs are not medical, legal, financial, tax, accounting, mental-health, or safety advice.",
      callerResponsibility:
        "The caller is responsible for reviewing outputs and for all decisions or actions based on them.",
    },
    payment: {
      protocol: "x402 exact-scheme Base USDC",
      prices: `${config.publicBaseUrl}/v1/catalog`,
      finality:
        "A successfully settled and delivered job is final and non-refundable except where mandatory law requires otherwise.",
      failedDelivery:
        "A matching Idempotency-Key may provide one bounded retry when a verified or settled payment did not produce a delivered response. No automatic cash refund is promised.",
    },
    privacy: {
      retention:
        "Request bodies and provider response bodies are not intentionally logged or persisted. Privacy-preserving HMAC fingerprints and aggregate operational telemetry may be retained.",
      subprocessors: ["Venice.ai", "Coinbase CDP x402 Facilitator", "Vercel", "Upstash Redis"],
    },
    availability:
      "The service, models, prices, limits, and routes may change, pause, or end without notice. Abuse controls may reject or suspend callers.",
    warranties:
      "The service is provided as-is and as-available without warranties about outputs, model availability, fitness, merchantability, or non-infringement to the maximum extent permitted by law.",
    liability:
      "To the maximum extent permitted by law, the operator is not liable for indirect, incidental, special, consequential, or reliance losses arising from use of the service.",
    governingLaw:
      "These terms are governed by laws applicable to the operator, subject to any mandatory rights that cannot lawfully be waived.",
    changes:
      "The effective date and version identify the terms in force. Continued use after an update constitutes acceptance of the updated terms.",
  };
}
