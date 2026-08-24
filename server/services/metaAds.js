// Meta Marketing API — turns a course into a real Facebook/Instagram Lead
// Generation ad: campaign -> lead form -> ad set -> creative -> ad, all
// created PAUSED so nothing spends money until the teacher explicitly
// reviews the AI-made creative and hits "Go live" (see routes/metaAds.js).
//
// Needs real setup on Meta's side before this can do anything — a Business
// Manager, an Ad Account with a payment method on it, a connected Facebook
// Page, and a token with ads_management permission. See README. Without
// that, isConfigured() is false and "Advertise this course" falls back to
// generating the creative only, for the teacher to use in Ads Manager by
// hand — same demo-vs-real split as Razorpay elsewhere in this app.

const GRAPH_VERSION = "v20.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function isConfigured() {
  return Boolean(process.env.META_AD_ACCOUNT_ID && process.env.META_ACCESS_TOKEN && process.env.META_PAGE_ID);
}

function actId() {
  const id = process.env.META_AD_ACCOUNT_ID;
  return id.startsWith("act_") ? id : `act_${id}`;
}

async function graphPost(edgePath, body) {
  const res = await fetch(`${GRAPH}${edgePath}?access_token=${process.env.META_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Meta API (${edgePath}): ${data.error?.message || "request failed"}`);
  return data;
}

async function uploadImage(buffer, filename) {
  const form = new FormData();
  form.append(filename, new Blob([buffer], { type: "image/png" }), filename);
  const res = await fetch(`${GRAPH}/${actId()}/adimages?access_token=${process.env.META_ACCESS_TOKEN}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Meta API (adimages): " + (data.error?.message || "upload failed"));
  const images = data.images || {};
  const first = Object.values(images)[0];
  if (!first?.hash) throw new Error("Meta API (adimages): no image hash returned.");
  return first.hash;
}

// Full pipeline: image -> campaign -> lead form -> ad set -> creative -> ad.
// Every object is created with status PAUSED — see activate() for the one
// explicit step that actually turns spend on.
async function createLeadCampaign(course, imageBuffer, adCopyText, courseUrl) {
  const imageHash = await uploadImage(imageBuffer, `course-${course.id}.png`);

  const campaign = await graphPost(`/${actId()}/campaigns`, {
    name: `MoleQule Prep — ${course.title}`,
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    special_ad_categories: [],
  });

  const form = await graphPost(`/${process.env.META_PAGE_ID}/leadgen_forms`, {
    name: `${course.title} — interest form`,
    locale: "en_US",
    questions: JSON.stringify([{ type: "FULL_NAME" }, { type: "EMAIL" }, { type: "PHONE" }]),
    privacy_policy: JSON.stringify({ url: `${process.env.BASE_URL}/privacy.html`, link_text: "Privacy Policy" }),
  });

  const adSet = await graphPost(`/${actId()}/adsets`, {
    name: `${course.title} — ad set`,
    campaign_id: campaign.id,
    daily_budget: 50000, // smallest currency unit (paise) -> ₹500/day default; editable in Ads Manager before going live
    billing_event: "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: JSON.stringify({ geo_locations: { countries: ["IN"] }, age_min: 16, age_max: 45 }),
    status: "PAUSED",
    promoted_object: JSON.stringify({ page_id: process.env.META_PAGE_ID }),
  });

  const creative = await graphPost(`/${actId()}/adcreatives`, {
    name: `${course.title} — creative`,
    object_story_spec: JSON.stringify({
      page_id: process.env.META_PAGE_ID,
      link_data: {
        image_hash: imageHash,
        link: courseUrl,
        message: adCopyText,
        call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: form.id } },
      },
    }),
  });

  const ad = await graphPost(`/${actId()}/ads`, {
    name: `${course.title} — ad`,
    adset_id: adSet.id,
    creative: JSON.stringify({ creative_id: creative.id }),
    status: "PAUSED",
  });

  return {
    campaignId: campaign.id,
    adSetId: adSet.id,
    creativeId: creative.id,
    formId: form.id,
    adId: ad.id,
    manageUrl: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${process.env.META_AD_ACCOUNT_ID.replace("act_", "")}`,
  };
}

// The one step that actually spends money — flips the campaign (and by
// extension its ad set/ad) to ACTIVE. Kept separate from campaign creation
// on purpose, so a teacher always sees the AI-made creative before
// anything can go live, even in a "one click" flow.
async function activateCampaign(campaignId) {
  await graphPost(`/${campaignId}`, { status: "ACTIVE" });
}

module.exports = { isConfigured, createLeadCampaign, activateCampaign };
