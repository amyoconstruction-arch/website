'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const emailAddress = 'Amyoconstruction@gmail.com';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// The catalog retains the profile's project periods and historical status notes.
let allProjects = [];
let visibleProjects = 9;
const featured = [
  {id:'amyo-023', image:'p22-4.jpg', title:'Nuvali Driving Range', alt:'Illuminated Nuvali Driving Range exterior at night', scope:'Electrical works', position:'center 65%'},
  {id:'amyo-008', image:'p10-1.jpg', title:'A renewed residential exterior', alt:'Residential exterior with roof, fascia and gate', scope:'Roofing, gutter, exterior repairs and electrical works', position:'center'},
  {id:'amyo-039', image:'p37-4.jpg', title:'Structure for what comes next', alt:'Project team at a logistics warehouse steel structure', scope:'Logistics warehouse structural works', position:'center'},
  {id:'amyo-033', image:'p32-3.jpg', title:'A considered office interior', alt:'Renovated Tycoon Center office with wood finishes and seating', scope:'Office renovation and interior works', position:'center'},
  {id:'amyo-028', image:'p27-2.jpg', title:'Everyday spaces, reworked', alt:'Renovated bathroom with a glass shower enclosure', scope:'Three-bathroom renovation', position:'center 48%'},
  {id:'amyo-034', image:'p33-2.jpg', title:'A stronger first impression', alt:'New residential fence and gate installation', scope:'Fence replacement and automatic gate installation', position:'center'},
  {id:'amyo-035', image:'p34-4.jpg', title:'Renewing a community space', alt:'Green replacement roofing at Hope Philippines Church', scope:'Roofing, ceiling, masonry and electrical works', position:'center'},
  {id:'amyo-049', image:'p43-3.jpg', title:'Supporting a place for sport', alt:'Project team working beside a lighting structure at a baseball stadium', scope:'Electrical and plumbing works at Rizal Memorial Baseball Stadium', position:'center'}
];

async function loadCompanyContent() {
  try {
    const response = await fetch('projects.json');
    if (!response.ok) throw new Error('Catalog unavailable');
    const data = await response.json();
    if (!Array.isArray(data.projects)) throw new Error('Catalog unavailable');
    allProjects = data.projects;
    renderFeatured();
    renderTeam(data.team || []);
    $('#credentials-list').innerHTML = (data.credentials || []).map(item => `<li>${escapeHTML(item.title)}</li>`).join('');
    const categories = [...new Set(allProjects.map(project => project.category))].sort();
    $('#category-filter').insertAdjacentHTML('beforeend', categories.map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join(''));
    const years = [...new Set(allProjects.flatMap(projectYears))].sort((a,b) => b-a);
    $('#year-filter').insertAdjacentHTML('beforeend', years.map(year => `<option value="${year}">${year}</option>`).join('') + '<option value="undated">Date not stated</option>');
    renderCatalog();
  } catch (error) {
    $('#result-count').textContent = 'The project catalog could not load. Please refresh or download the company profile.';
    $('#featured-projects').innerHTML = '<p>Explore the full project portfolio in the downloadable company profile.</p>';
  }
}

function renderFeatured() {
  $('#featured-projects').innerHTML = featured.map(item => {
    const project = allProjects.find(record => record.id === item.id);
    if (!project) return '';
    return `<article class="project-feature"><div class="feature-photo"><img src="assets/projects/${item.image}" alt="${escapeHTML(item.alt)}" width="1600" height="1200" style="object-position:${item.position}" loading="lazy"><span>${escapeHTML(project.category)}</span></div><div class="feature-meta"><span>${escapeHTML(project.location)}</span><span>${escapeHTML(project.period)}</span></div><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.scope)}</p><button class="feature-details" data-project-id="${item.id}">View project record ↗</button></article>`;
  }).join('');
}

function renderTeam(team) {
  const images = ['wilmer-orlaza','paul-john-llaneta','anna-margarita-orlaza','jonny-malabago','mary-mae-ylagan','marvin-orlaza'];
  $('#team-grid').innerHTML = team.map((member,index) => `<article class="team-card ${index === 3 ? 'jonny' : index === 5 ? 'marvin' : ''}"><div class="team-image"><img src="assets/team/${images[index]}.jpg" alt="${escapeHTML(member.name)}" width="600" height="700" loading="lazy"></div><h3>${escapeHTML(member.name)}</h3><p>${escapeHTML(member.role)}</p></article>`).join('');
}

function projectYears(project) {
  const recordedYears = [...new Set((project.period?.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number))];
  if (!recordedYears.length) return project.year ? [Number(project.year)] : [];
  const firstYear = Math.min(...recordedYears);
  const lastYear = Math.max(...recordedYears);
  return Array.from({length:lastYear-firstYear+1}, (_,index) => firstYear+index);
}

function filteredProjects() {
  const search = $('#project-search').value.trim().toLocaleLowerCase();
  const category = $('#category-filter').value;
  const year = $('#year-filter').value;
  return allProjects.filter(project => {
    const text = [project.title, project.client, project.location, project.scope, project.period, project.category].join(' ').toLocaleLowerCase();
    const recordedYears = projectYears(project);
    return (!search || text.includes(search)) && (!category || project.category === category) && (!year || (year === 'undated' ? !recordedYears.length : recordedYears.includes(Number(year))));
  });
}

function renderCatalog() {
  const projects = filteredProjects();
  const shown = projects.slice(0, visibleProjects);
  $('#project-catalog').innerHTML = shown.map(project => `<article class="catalog-card" id="${project.id}" tabindex="-1"><p class="catalog-category">${escapeHTML(project.category)}</p><h3>${escapeHTML(project.title)}</h3><p class="client">${escapeHTML(project.client)}</p><p class="scope">${escapeHTML(project.scope)}</p><div class="catalog-meta"><span>${escapeHTML(project.location)}</span><span>${escapeHTML(project.period)}</span></div>${project.statusNote ? `<details><summary>Record note</summary><p>${escapeHTML(project.statusNote)}</p></details>` : ''}</article>`).join('');
  $('#result-count').textContent = `${projects.length} project record${projects.length === 1 ? '' : 's'}${projects.length > shown.length ? ` · showing ${shown.length}` : ''}`;
  $('#load-more').hidden = shown.length >= projects.length;
  $('#catalog-empty').hidden = projects.length > 0;
  $('#reset-filters').hidden = !($('#project-search').value || $('#category-filter').value || $('#year-filter').value);
}

for (const control of ['#project-search','#category-filter','#year-filter']) {
  $(control).addEventListener(control === '#project-search' ? 'input' : 'change', () => { visibleProjects = 9; renderCatalog(); });
}
$('#reset-filters').addEventListener('click', () => { $('#project-search').value = ''; $('#category-filter').value = ''; $('#year-filter').value = ''; visibleProjects = 9; renderCatalog(); $('#project-search').focus(); });
$('#load-more').addEventListener('click', () => { const previousCount = $$('.catalog-card').length; visibleProjects += 9; renderCatalog(); $$('.catalog-card')[previousCount]?.focus({preventScroll:true}); });
$('#featured-projects').addEventListener('click', event => {
  const button = event.target.closest('[data-project-id]');
  if (!button) return;
  const project = allProjects.find(record => record.id === button.dataset.projectId);
  $('#project-search').value = project.title;
  $('#category-filter').value = '';
  $('#year-filter').value = '';
  visibleProjects = allProjects.length;
  renderCatalog();
  const target = document.getElementById(project.id);
  $('#catalog').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  target?.focus({preventScroll:true});
});

const menuToggle = $('.menu-toggle');
const mobileMenu = $('#mobile-navigation');
function closeMenu() { mobileMenu.hidden = true; menuToggle.setAttribute('aria-expanded','false'); menuToggle.setAttribute('aria-label','Open navigation'); }
menuToggle.addEventListener('click', () => { const expanded = menuToggle.getAttribute('aria-expanded') === 'true'; mobileMenu.hidden = expanded; menuToggle.setAttribute('aria-expanded',String(!expanded)); menuToggle.setAttribute('aria-label',expanded ? 'Open navigation' : 'Close navigation'); });
mobileMenu.addEventListener('click', event => { if (event.target.closest('a,button')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

// Enquiry data stays in memory only. The same request ID is kept through retries.
const enquiry = $('#enquiry-dialog');
const form = $('#enquiry-form');
let step = 1;
let submissionAvailable = null;
let submitting = false;
let requestId = newRequestId();
let submitted = false;
let enquiryOpener = null;
let briefText = '';

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function checkAvailability() {
  try {
    const response = await fetch('/api/inquiries', {cache:'no-store', signal:AbortSignal.timeout(8000)});
    const data = response.ok ? await response.json() : null;
    submissionAvailable = data?.available === true;
  } catch (_) { submissionAvailable = false; }
  updateAvailability();
}

function updateAvailability() {
  $('#availability-note').textContent = submissionAvailable === false ? 'Online submission is currently unavailable. You can continue with a prepared email to AMYO.' : submissionAvailable === true ? 'Your enquiry will be saved for AMYO to review.' : 'Checking online enquiry availability…';
  if (!submitting) $('#submit-enquiry').innerHTML = submissionAvailable === false ? 'Prepare email draft <span aria-hidden="true">↗</span>' : 'Submit enquiry <span aria-hidden="true">↗</span>';
}

function resetEnquiry() {
  form.reset(); requestId = newRequestId(); submitted = false;
  $('#funnel-content').hidden = false; $('#enquiry-success').hidden = true; $('#enquiry-fallback').hidden = true;
  showStep(1,false);
}

function openEnquiry(trigger) {
  if (submitted) resetEnquiry();
  enquiryOpener = trigger;
  if (trigger?.dataset.service) {
    const selected = $$('input[name="service"]',form).find(input => input.value === trigger.dataset.service);
    if (selected) selected.checked = true;
  }
  enquiry.showModal(); document.body.classList.add('dialog-open');
  $('#enquiry-title').tabIndex = -1; $('#enquiry-title').focus();
  checkAvailability();
}

document.addEventListener('click', event => { const trigger = event.target.closest('[data-inquire]'); if (trigger) openEnquiry(trigger); });
function closeEnquiry() { if (!submitting) enquiry.close(); }
$('#close-enquiry').addEventListener('click',closeEnquiry);
$('#finish-enquiry').addEventListener('click',closeEnquiry);
enquiry.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
enquiry.addEventListener('close', () => { document.body.classList.remove('dialog-open'); enquiryOpener?.focus(); });

function showStep(nextStep,focus = true) {
  step = nextStep;
  const labels = ['Your service','Your project','Review & contact'];
  const titles = ['Let’s make a start.','Tell us about the project.','A few final details.'];
  $$('.funnel-step').forEach(fieldset => { fieldset.hidden = Number(fieldset.dataset.step) !== step; });
  $('#step-label').textContent = `Step ${step} of 3 / ${labels[step-1]}`;
  $('#enquiry-title').textContent = titles[step-1];
  $('#progress-fill').style.width = `${step / 3 * 100}%`;
  $('#step-counter').textContent = `0${step} / 03`;
  $('#previous-step').hidden = step === 1;
  $('#next-step').hidden = step === 3;
  $('#submit-enquiry').hidden = step !== 3;
  clearError();
  if (step === 3) renderReview();
  enquiry.scrollTop = 0;
  if (focus) { $('#enquiry-title').tabIndex = -1; $('#enquiry-title').focus({preventScroll:true}); }
}

function clearError() { $('#form-error').hidden = true; $('#form-error').textContent = ''; $$('[aria-invalid="true"]',form).forEach(field => field.removeAttribute('aria-invalid')); }
function showError(message, field) {
  $('#form-error').textContent = message; $('#form-error').hidden = false;
  if (field) { field.setAttribute('aria-invalid','true'); field.setAttribute('aria-describedby','form-error'); field.focus(); }
  else $('#form-error').scrollIntoView({block:'nearest'});
}

function validateStep(currentStep) {
  clearError();
  if (currentStep === 1 && !$('input[name="service"]:checked',form)) { showError('Choose a service to continue.', $('input[name="service"]',form)); return false; }
  const fieldset = $(`.funnel-step[data-step="${currentStep}"]`);
  const names = {propertyType:'property type',location:'city or project area',timeline:'preferred timing',description:'project description',name:'name',email:'email address',phone:'phone number',consent:'consent'};
  for (const field of $$('input,select,textarea',fieldset)) {
    if (field.name === 'service') continue;
    if (field.name !== 'consent') field.value = field.value.trim();
    if (field.required && (field.type === 'checkbox' ? !field.checked : !field.value)) { showError(field.name === 'consent' ? 'Please agree to the use of your details to handle this enquiry.' : `Please enter or select your ${names[field.name] || field.name}.`,field); return false; }
    if (field.name === 'email' && field.value && !field.validity.valid) { showError('Enter a valid email address, such as you@example.com.',field); return false; }
    if ((field.name === 'name' || field.name === 'location') && field.value.length < 2) { showError(`Please enter at least two characters for your ${names[field.name]}.`,field); return false; }
    if (field.name === 'description' && (field.value.length < 10 || field.value.length > 4000)) { showError('Describe the project in 10–4,000 characters.',field); return false; }
    if (field.name === 'phone' && field.value && !/^[+()\d\s.\-]+$/.test(field.value)) { showError('Use numbers and common phone punctuation for your phone number.',field); return false; }
    if (field.name === 'phone' && !/^\d{7,15}$/.test(field.value.replace(/\D/g,''))) { showError('Enter a phone number with 7–15 digits so AMYO can contact you.',field); return false; }
    if (field.maxLength > 0 && field.value.length > field.maxLength) { showError(`Please shorten your ${names[field.name] || field.name}.`,field); return false; }
  }
  return true;
}

$('#next-step').addEventListener('click', () => { if (validateStep(step)) showStep(step+1); });
$('#previous-step').addEventListener('click', () => showStep(Math.max(1,step-1)));

function formValues() {
  const raw = Object.fromEntries(new FormData(form));
  const result = {};
  for (const key of ['service','propertyType','location','timeline','budget','description','name','email','phone','website']) result[key] = String(raw[key] || '').trim();
  result.consent = $('input[name="consent"]',form).checked;
  result.requestId = requestId;
  return result;
}

function renderReview() {
  const data = formValues();
  const pairs = [['Service',data.service],['Property',data.propertyType],['Location',data.location],['Timing',data.timeline],['Budget',data.budget || 'Not yet defined'],['Your brief',data.description]];
  $('#review-details').innerHTML = pairs.map(([key,value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd>`).join('');
}

function showFallback(message,uncertain = false) {
  const data = formValues();
  briefText = `Hello AMYO Construction,\n\nI would like to discuss a project.\n\nService: ${data.service}\nProperty type: ${data.propertyType}\nLocation: ${data.location}\nPreferred timing: ${data.timeline}\nIndicative budget: ${data.budget || 'Not yet defined'}\n\nProject brief:\n${data.description}\n\nName: ${data.name}\nEmail: ${data.email}\nPhone: ${data.phone || 'Not provided'}\n\nEnquiry reference: ${data.requestId}\nI agree that AMYO may use these details to review and respond to this enquiry.\n\nThank you.`;
  $('#email-draft-link').href = `mailto:${emailAddress}?subject=${encodeURIComponent(`Project enquiry — ${data.service} — ${data.location}`)}&body=${encodeURIComponent(briefText)}`;
  $('#fallback-message').textContent = message || 'Online submission is currently unavailable. Open the prepared email below, review it in your email app and send it to AMYO.';
  $('#enquiry-fallback strong').textContent = uncertain ? 'We could not confirm whether the online request was saved. You can return to review and retry with the same reference.' : 'No enquiry has been sent by this form.';
  $('#funnel-content').hidden = true; $('#enquiry-fallback').hidden = false;
  $('#copy-status').textContent = '';
  const title = $('#enquiry-fallback h2'); title.tabIndex = -1; title.focus(); enquiry.scrollTop = 0;
}

$('#back-to-review').addEventListener('click', () => { $('#enquiry-fallback').hidden = true; $('#funnel-content').hidden = false; showStep(3); checkAvailability(); });
$('#copy-brief').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(briefText); $('#copy-status').textContent = 'Project brief copied. Paste it into an email to Amyoconstruction@gmail.com.'; }
  catch (_) { $('#copy-status').textContent = 'Copying is unavailable in this browser. Use the email draft link or return to your brief.'; }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  if (step < 3) { if (validateStep(step)) showStep(step+1); return; }
  for (let candidate = 1; candidate <= 3; candidate++) {
    if (candidate !== step) {
      const fieldset = $(`.funnel-step[data-step="${candidate}"]`);
      if (candidate === 1 && !$('input[name="service"]:checked',fieldset)) { showStep(1); validateStep(1); return; }
    }
  }
  if (!validateStep(3)) return;
  if (submissionAvailable === false) { showFallback(); return; }
  submitting = true;
  $('#submit-enquiry').disabled = true; $('#previous-step').disabled = true; $('#close-enquiry').disabled = true;
  $('#submit-enquiry').textContent = 'Saving your enquiry…';
  let response;
  try {
    response = await fetch('/api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(formValues()),signal:AbortSignal.timeout(20000)});
    let result;
    try { result = await response.json(); } catch (_) { throw new Error('The response could not be confirmed.'); }
    if (response.ok && result.ok === true && result.requestId) {
      submitted = true;
      $('#funnel-content').hidden = true; $('#enquiry-success').hidden = false;
      $('#request-reference').textContent = `Reference: ${result.requestId}`;
      const title = $('#enquiry-success h2'); title.tabIndex = -1; title.focus(); enquiry.scrollTop = 0;
    } else if (response.status === 400) {
      const invalidNames = Array.isArray(result.fields) ? result.fields : result.fields && typeof result.fields === 'object' ? Object.keys(result.fields) : [];
      const field = invalidNames.map(name => form.elements.namedItem(name)).find(item => item && item.tagName);
      if (field) showStep(Number(field.closest('.funnel-step').dataset.step));
      showError(typeof result.error === 'string' ? result.error : 'Please check your details and try again.',field);
    } else if (response.status === 409) {
      showError('This enquiry reference has already been used with different details. Please contact AMYO by email and include your reference: ' + requestId);
    } else if (response.status === 429) {
      showError('Too many enquiries were submitted recently. Please wait before retrying, or contact Amyoconstruction@gmail.com directly.');
    } else {
      showFallback('Online submission is unavailable right now. You can prepare an email to AMYO with the same project details.', response.status >= 500);
    }
  } catch (_) {
    showFallback('The connection did not confirm your enquiry. Return to review to retry with the same reference, or use the prepared email to contact AMYO.',true);
  } finally {
    submitting = false;
    $('#submit-enquiry').disabled = false; $('#previous-step').disabled = false; $('#close-enquiry').disabled = false;
    updateAvailability();
  }
});

const privacyDialog = $('#privacy-dialog');
$('#privacy-open').addEventListener('click', () => { privacyDialog.showModal(); document.body.classList.add('dialog-open'); });
$('#privacy-close').addEventListener('click', () => privacyDialog.close());
privacyDialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));

loadCompanyContent();
