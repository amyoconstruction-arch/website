'use strict';

const AMYO_EMAIL = 'Amyoconstruction@gmail.com';
const $ = selector => document.querySelector(selector);
const STATUS_LABELS = {new:'New',contacted:'Contacted',quoted:'Quoted',won:'Won',closed:'Closed'};
const dateFormatter = new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'});
let authenticated = false;
let items = [];
let page = 1;
let total = 0;
let listSequence = 0;
let listController = null;
let searchTimer = null;
let selected = null;
let conflictItem = null;
let detailOpener = null;
let saving = false;
let settingPassword = false;
let authBusy = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function setMessage(id,text) { const node = $(id); node.textContent = text || ''; node.hidden = !text; }
function formatDate(value) { if (!value) return 'Not recorded'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Not recorded' : dateFormatter.format(date); }
function phoneTarget(value) { return String(value || '').replace(/[^\d+]/g,''); }
function statusKey(value) { return Object.hasOwn(STATUS_LABELS,value) ? value : 'new'; }
function statusBadge(value) { const status = statusKey(value); return element('span',`status-badge status-${status}`,STATUS_LABELS[status]); }
function isDirty() { return selected && ($('#detail-notes').value !== String(selected.admin_notes || '') || $('#detail-status-select').value !== statusKey(selected.status)); }

class ApiError extends Error {
  constructor(status,payload) { super(typeof payload?.error === 'string' ? payload.error : 'The request could not be completed. Please try again.'); this.status = status; this.code = payload?.code; this.item = payload?.item; }
}
async function api(action,{method='GET',data,params={},signal} = {}) {
  const url = new URL('/api/admin',window.location.origin);
  url.searchParams.set('action',action);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  const options = {method,credentials:'include',cache:'no-store',signal:signal || AbortSignal.timeout(25000),headers:{Accept:'application/json'}};
  if (data !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
  const response = await fetch(url,options);
  let result;
  try { result = await response.json(); } catch (_) { throw new ApiError(response.status,{error:'The service did not return a readable response. Please try again.'}); }
  if (!response.ok) throw new ApiError(response.status,result);
  return result;
}

function selectAuthTab(tab) {
  const link = tab === 'link';
  $('#link-tab').setAttribute('aria-selected',String(link)); $('#link-tab').tabIndex = link ? 0 : -1;
  $('#password-tab').setAttribute('aria-selected',String(!link)); $('#password-tab').tabIndex = link ? -1 : 0;
  $('#link-panel').hidden = !link; $('#password-panel').hidden = link;
  setMessage('#auth-error','');
}
$('#link-tab').addEventListener('click',() => selectAuthTab('link'));
$('#password-tab').addEventListener('click',() => selectAuthTab('password'));
for (const id of ['#link-tab','#password-tab']) {
  $(id).addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const tab = event.key === 'Home' ? 'link' : event.key === 'End' ? 'password' : id === '#link-tab' ? 'password' : 'link'; selectAuthTab(tab); $(`#${tab}-tab`).focus();
  });
}
function setAuthBusy(busy) { authBusy = busy; $('#send-link').disabled = busy; $('#password-login').disabled = busy; $('#login-password').disabled = busy; }
function showLogin(message = '') {
  authenticated = false; items = []; selected = null; conflictItem = null;
  listSequence++; listController?.abort(); clearTimeout(searchTimer);
  if ($('#detail-dialog').open) $('#detail-dialog').close();
  if ($('#account-dialog').open) $('#account-dialog').close();
  $('#inquiry-rows').replaceChildren(); $('#detail-facts').replaceChildren(); $('#detail-description').textContent = ''; $('#detail-notes').value = '';
  for (const id of ['#detail-title','#detail-phone','#detail-email','#detail-date','#detail-status','#detail-consent','#detail-request-id','#detail-updated']) $(id).textContent = '';
  $('#detail-phone').removeAttribute('href'); $('#detail-email').removeAttribute('href');
  $('#inbox-search').value = ''; $('#status-filter').value = 'all'; total = 0; page = 1;
  $('#total-count').textContent = '—'; $('#list-summary').textContent = ''; $('#last-refreshed').textContent = '';
  for (const id of ['#inbox-error','#detail-message','#detail-error','#account-message','#account-error']) setMessage(id,'');
  $('#app-loading').hidden = true; $('#dashboard').hidden = true; $('#session-controls').hidden = true; $('#login-screen').hidden = false;
  $('#login-password').value = ''; $('#new-password').value = ''; $('#confirm-password').value = '';
  setMessage('#auth-message',message); setMessage('#auth-error','');
}
async function showDashboard() {
  authenticated = true;
  $('#app-loading').hidden = true; $('#login-screen').hidden = true; $('#dashboard').hidden = false; $('#session-controls').hidden = false;
  $('#login-password').value = ''; setMessage('#auth-error',''); setMessage('#auth-message','');
  page = 1; $('#inbox-title').tabIndex = -1; $('#inbox-title').focus({preventScroll:true});
  await loadInquiries();
}
function handleSessionError(error) {
  if (error instanceof ApiError && error.status === 401) { showLogin('Your session has ended. Sign in again to continue.'); return true; }
  return false;
}

$('#send-link').addEventListener('click',async () => {
  if (authBusy) return;
  setAuthBusy(true); setMessage('#auth-error',''); setMessage('#auth-message',''); $('#send-link').textContent = 'Sending sign-in link…';
  try {
    const result = await api('send-link',{method:'POST',data:{email:AMYO_EMAIL}});
    if (result.ok !== true) throw new Error('The link could not be requested. Please try again.');
    setMessage('#auth-message','Open the sign-in link sent to Amyoconstruction@gmail.com in this browser. Check Spam if it is not in the inbox.');
  } catch (error) { setMessage('#auth-error',error.message || 'Unable to send a sign-in link. Please try again.'); }
  finally { setAuthBusy(false); $('#send-link').textContent = 'Email me a sign-in link ↗'; }
});
$('#password-panel').addEventListener('submit',async event => {
  event.preventDefault(); if (authBusy || !$('#password-panel').reportValidity()) return;
  const password = $('#login-password').value;
  setAuthBusy(true); setMessage('#auth-error',''); setMessage('#auth-message',''); $('#password-login').textContent = 'Signing in…';
  try {
    const result = await api('login',{method:'POST',data:{email:AMYO_EMAIL,password}});
    if (result.ok !== true) throw new Error('Sign-in could not be confirmed. Please try again.');
    await showDashboard();
  } catch (error) { setMessage('#auth-error',error.message || 'Unable to sign in. Please try again.'); }
  finally { $('#login-password').value = ''; setAuthBusy(false); $('#password-login').textContent = 'Sign in ↗'; }
});
$('#sign-out').addEventListener('click',async () => {
  if (saving || settingPassword) return;
  $('#sign-out').disabled = true;
  let confirmed = false;
  try { const result = await api('logout',{method:'POST',data:{}}); confirmed = result.ok === true; }
  catch (_) { /* Clear the private workspace even when server sign-out cannot be confirmed. */ }
  finally {
    showLogin(confirmed ? 'You have signed out.' : 'Signed out on this browser. Server sign-out could not be confirmed. Close this window if using a shared device.');
    $('#sign-out').disabled = false;
  }
});

async function loadInquiries() {
  if (!authenticated) return;
  clearTimeout(searchTimer);
  const sequence = ++listSequence;
  listController?.abort(); const controller = new AbortController(); listController = controller;
  const timeout = setTimeout(() => controller.abort(),25000);
  $('#list-loading').hidden = false; $('#table-wrap').hidden = true; $('#empty-state').hidden = true; $('#pagination').hidden = true;
  $('#refresh-inbox').disabled = true; setMessage('#inbox-error',''); $('#list-summary').textContent = 'Loading enquiries…';
  try {
    const result = await api('inquiries',{params:{page,status:$('#status-filter').value,q:$('#inbox-search').value.trim()},signal:controller.signal});
    if (sequence !== listSequence) return;
    if (!Array.isArray(result.items)) throw new Error('The enquiry list could not be read. Please refresh.');
    items = result.items; total = Math.max(0,Number(result.total) || 0); page = Math.max(1,Number(result.page) || page);
    if (items.length === 0 && total > 0 && page > 1) { page = Math.max(1,Math.ceil(total/25)); clearTimeout(timeout); await loadInquiries(); return; }
    renderInquiries();
    $('#last-refreshed').textContent = `Updated ${formatDate(new Date().toISOString())} · PHT`;
  } catch (error) {
    if (sequence !== listSequence) return;
    if (!handleSessionError(error)) {
      const message = error.name === 'AbortError' ? 'The request took too long. Please refresh to try again.' : error.message || 'The inbox could not load. Please refresh.';
      setMessage('#inbox-error',message); $('#list-summary').textContent = 'Enquiries could not be loaded.';
    }
  } finally { clearTimeout(timeout); if (sequence === listSequence) { $('#list-loading').hidden = true; $('#refresh-inbox').disabled = false; } }
}

function renderInquiries() {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = element('tr');
    const contact = element('td');
    const openName = element('button','client-open',item.name || 'Unnamed client'); openName.type = 'button'; openName.addEventListener('click',() => openDetail(item,openName)); contact.append(openName);
    if (item.phone) { const phone = element('a','table-phone',item.phone); phone.href = `tel:${phoneTarget(item.phone)}`; contact.append(phone); }
    else contact.append(element('span','table-phone no-phone','Phone not provided'));
    const email = element('a','table-email',item.email || 'Email not provided'); if (item.email) email.href = `mailto:${encodeURIComponent(item.email)}`; contact.append(email);
    const project = element('td'); project.append(element('p','table-project',item.service || 'Service not specified'),element('p','table-location',item.location || 'Location not provided'));
    const received = element('td','received-time',formatDate(item.created_at));
    const status = element('td'); status.append(statusBadge(item.status));
    const action = element('td'); const open = element('button','row-open','↗'); open.type = 'button'; open.setAttribute('aria-label',`View enquiry from ${item.name || 'client'}`); open.addEventListener('click',() => openDetail(item,open)); action.append(open);
    row.append(contact,project,received,status,action); fragment.append(row);
  }
  $('#inquiry-rows').replaceChildren(fragment);
  const filtered = Boolean($('#inbox-search').value.trim() || $('#status-filter').value !== 'all');
  $('#total-count').textContent = String(total); $('#total-label').textContent = filtered ? 'matching enquiries' : total === 1 ? 'enquiry' : 'enquiries';
  $('#table-wrap').hidden = items.length === 0; $('#empty-state').hidden = items.length > 0;
  $('#empty-title').textContent = filtered ? 'No matches found.' : 'A clear inbox.';
  $('#empty-copy').textContent = filtered ? 'Try a different name, project or status.' : 'New project enquiries will appear here.';
  $('#clear-filters').hidden = !filtered;
  const start = total > 0 ? (page-1)*25+1 : 0; const end = Math.min(total,(page-1)*25+items.length);
  $('#list-summary').textContent = total ? `${start}–${end} of ${total} enquir${total === 1 ? 'y' : 'ies'}` : 'No enquiries to show';
  $('#pagination').hidden = total <= 25;
  $('#page-label').textContent = `Page ${page} of ${Math.max(1,Math.ceil(total/25))}`;
  $('#previous-page').disabled = page <= 1; $('#next-page').disabled = page*25 >= total;
}
$('#inbox-search').addEventListener('input',() => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; loadInquiries(); },300); });
$('#inbox-search').addEventListener('keydown',event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); page = 1; loadInquiries(); } });
$('#status-filter').addEventListener('change',() => { page = 1; loadInquiries(); });
$('#refresh-inbox').addEventListener('click',() => loadInquiries());
$('#clear-filters').addEventListener('click',() => { $('#inbox-search').value = ''; $('#status-filter').value = 'all'; page = 1; loadInquiries(); });
$('#previous-page').addEventListener('click',() => { if (page > 1) { page--; loadInquiries(); $('#inbox-title').focus({preventScroll:true}); } });
$('#next-page').addEventListener('click',() => { if (page*25 < total) { page++; loadInquiries(); $('#inbox-title').focus({preventScroll:true}); } });

function populateDetail(item) {
  selected = item; conflictItem = null;
  $('#detail-title').textContent = item.name || 'Unnamed client';
  $('#detail-phone').hidden = !item.phone; $('#detail-no-phone').hidden = Boolean(item.phone);
  $('#detail-phone').textContent = item.phone || ''; $('#detail-phone').href = `tel:${phoneTarget(item.phone)}`;
  $('#detail-email').textContent = item.email || 'Email not provided'; $('#detail-email').href = item.email ? `mailto:${encodeURIComponent(item.email)}` : '#';
  $('#detail-date').textContent = `Received ${formatDate(item.created_at)} · PHT`;
  const status = statusKey(item.status); $('#detail-status').className = `status-badge status-${status}`; $('#detail-status').textContent = STATUS_LABELS[status];
  const facts = document.createDocumentFragment();
  for (const [label,value] of [['Service',item.service],['Property type',item.property_type],['Location',item.location],['Timing',item.timeline],['Budget',item.budget]]) facts.append(element('dt','',label),element('dd','',value || 'Not provided'));
  $('#detail-facts').replaceChildren(facts);
  $('#detail-description').textContent = item.description || 'No project description provided.';
  $('#detail-consent').textContent = item.consent_at ? `Enquiry consent recorded ${formatDate(item.consent_at)} · PHT` : 'Consent timestamp not recorded in this historical entry.';
  $('#detail-request-id').textContent = `Reference: ${item.request_id || 'Not recorded'}`;
  $('#detail-status-select').value = status; $('#detail-notes').value = item.admin_notes || '';
  $('#detail-updated').textContent = `Last saved ${formatDate(item.updated_at || item.created_at)} · PHT`;
  $('#conflict-actions').hidden = true; setMessage('#detail-message',''); setMessage('#detail-error',''); updateDirty();
}
function openDetail(item,opener) {
  detailOpener = opener; populateDetail(item); $('#detail-dialog').showModal(); document.body.classList.add('dialog-open'); $('#detail-dialog').scrollTop = 0; $('#detail-title').tabIndex = -1; $('#detail-title').focus({preventScroll:true});
}
function updateDirty() { const dirty = Boolean(isDirty()); $('#dirty-indicator').hidden = !dirty; $('#save-enquiry').disabled = saving || !dirty; }
function closeDetail() { if (saving) return; if (isDirty() && !window.confirm('Discard the unsaved changes to this enquiry?')) return; $('#detail-dialog').close(); }
$('#detail-close').addEventListener('click',closeDetail);
$('#detail-dialog').addEventListener('cancel',event => { event.preventDefault(); closeDetail(); });
$('#detail-dialog').addEventListener('close',() => { document.body.classList.remove('dialog-open'); selected = null; conflictItem = null; $('#detail-notes').value = ''; if (detailOpener?.isConnected) detailOpener.focus({preventScroll:true}); else if (authenticated) $('#refresh-inbox').focus({preventScroll:true}); });
$('#detail-status-select').addEventListener('change',updateDirty);
$('#detail-notes').addEventListener('input',updateDirty);
$('#manage-enquiry').addEventListener('submit',async event => {
  event.preventDefault(); if (!selected || saving || !isDirty()) return;
  if ($('#detail-notes').value.length > 4000) { setMessage('#detail-error','Keep internal notes to 4,000 characters or fewer.'); $('#detail-notes').focus(); return; }
  const payload = {requestId:selected.request_id,status:$('#detail-status-select').value,notes:$('#detail-notes').value,updatedAt:selected.updated_at};
  saving = true; updateDirty(); $('#detail-close').disabled = true; $('#detail-status-select').disabled = true; $('#detail-notes').disabled = true; $('#save-enquiry').textContent = 'Saving…'; setMessage('#detail-error',''); setMessage('#detail-message',''); $('#conflict-actions').hidden = true;
  try {
    const result = await api('inquiry',{method:'PATCH',data:payload});
    if (!result.item) throw new Error('Your changes could not be confirmed. Refresh before retrying.');
    populateDetail(result.item); setMessage('#detail-message','Changes saved.');
    await loadInquiries();
  } catch (error) {
    if (!handleSessionError(error)) {
      if (error.status === 409) { conflictItem = error.item || null; setMessage('#detail-error','This enquiry changed after you opened it. Your unsaved edits are still shown. Copy your notes if needed, then load the latest saved version before making changes.'); $('#conflict-actions').hidden = false; }
      else setMessage('#detail-error',error.message || 'The changes could not be saved. Please try again.');
    }
  } finally { saving = false; $('#detail-close').disabled = false; $('#detail-status-select').disabled = false; $('#detail-notes').disabled = false; $('#save-enquiry').textContent = 'Save changes ↗'; updateDirty(); }
});
$('#copy-unsaved-notes').addEventListener('click',async () => { try { await navigator.clipboard.writeText($('#detail-notes').value); setMessage('#detail-message','Your notes were copied. You can now load the latest saved version.'); } catch (_) { $('#detail-notes').focus(); $('#detail-notes').select(); setMessage('#detail-message','Your notes are selected. Use your browser’s Copy command before reloading.'); } });
$('#reload-saved-enquiry').addEventListener('click',async () => {
  if (!window.confirm('Load the latest saved version? This replaces the unsaved status and notes currently shown.')) return;
  if (conflictItem) { populateDetail(conflictItem); setMessage('#detail-message','Latest saved version loaded. You can now update it.'); }
  else { $('#detail-dialog').close(); await loadInquiries(); setMessage('#inbox-error','The inbox was refreshed. Open the enquiry again to view its current saved version.'); }
});

$('#account-open').addEventListener('click',() => {
  $('#set-password-form').reset(); setMessage('#account-error',''); setMessage('#account-message',''); $('#account-dialog').showModal(); document.body.classList.add('dialog-open'); $('#new-password').focus();
});
$('#account-close').addEventListener('click',() => { if (!settingPassword) $('#account-dialog').close(); });
$('#account-dialog').addEventListener('cancel',event => { if (settingPassword) event.preventDefault(); });
$('#account-dialog').addEventListener('close',() => { document.body.classList.remove('dialog-open'); $('#set-password-form').reset(); $('#account-open').focus(); });
$('#set-password-form').addEventListener('submit',async event => {
  event.preventDefault(); if (settingPassword) return;
  setMessage('#account-error',''); setMessage('#account-message','');
  const password = $('#new-password').value;
  if (password.length < 12 || password.length > 128) { setMessage('#account-error','Use a password with 12–128 characters.'); $('#new-password').focus(); return; }
  if (password !== $('#confirm-password').value) { setMessage('#account-error','The passwords do not match. Please enter them again.'); $('#confirm-password').focus(); return; }
  settingPassword = true; $('#set-password-button').disabled = true; $('#account-close').disabled = true; $('#new-password').disabled = true; $('#confirm-password').disabled = true; $('#set-password-button').textContent = 'Setting password…';
  try {
    const result = await api('set-password',{method:'POST',data:{password}});
    if (result.ok !== true) throw new Error('The password change could not be confirmed. Please try again.');
    setMessage('#account-message','Your sign-in password is set. Use the Password tab the next time you sign in.');
  } catch (error) { if (!handleSessionError(error)) setMessage('#account-error',error.message || 'The password could not be set. Please try again.'); }
  finally { settingPassword = false; $('#new-password').value = ''; $('#confirm-password').value = ''; $('#set-password-button').disabled = false; $('#account-close').disabled = false; $('#new-password').disabled = false; $('#confirm-password').disabled = false; $('#set-password-button').textContent = 'Set sign-in password ↗'; }
});

async function initialize() {
  // Keep callback codes in memory only and remove them from the address bar immediately.
  const incoming = new URL(window.location.href);
  const code = incoming.searchParams.get('code');
  const callbackError = incoming.searchParams.has('error') || incoming.searchParams.has('error_description') || /(?:access_token|error)=/.test(incoming.hash);
  if (code || callbackError) window.history.replaceState(null,'',incoming.pathname);
  if (callbackError) { showLogin(); setMessage('#auth-error','This sign-in link could not be used. Request a new link and open it in the same browser where you requested it.'); return; }
  if (code) {
    try { const result = await api('exchange-code',{method:'POST',data:{code}}); if (result.ok !== true) throw new Error('Sign-in could not be confirmed.'); await showDashboard(); }
    catch (_) { showLogin(); setMessage('#auth-error','This sign-in link has expired or does not match this browser. Request a new link here and open it in this browser, or sign in with your password.'); }
    return;
  }
  try { const session = await api('session'); if (session.authenticated === true) await showDashboard(); else showLogin(); }
  catch (error) { showLogin(); if (!(error instanceof ApiError && error.status === 401)) setMessage('#auth-error','The sign-in service is temporarily unavailable. Please try again.'); }
}

initialize();
