'use strict';

// Page object for the NS purchase form on dev.myndp.kz.
// Every method returns observations instead of asserting — checks live in checks.js.
// Waiting is event-based where possible: after a change the form recalculates the premium,
// and the Monitor tells us when that recalculation has started and finished.

const fs = require('fs-extra');

// ---------- Monitor ----------

// Watches a Playwright page during one scenario: JS errors, failed HTTP calls, step timings,
// and every premium recalculation (calc preview) in the order the form sent them.

// Known dev-environment noise that shows up on every run and is not about NS
const IGNORED_HTTP = [
  { status: 401, url: /\/iam\/v1\/auth\/refresh/ },
  { status: 404, url: /\/iam\/v1\/users\/avatar/ },
];
const IGNORED_CONSOLE = [/Failed to load resource: the server responded with a status of (401|404)/];
const isPreview = (url) => url.includes('/calc/products/ns/') && url.includes('/preview');

class Monitor {
  constructor(page) {
    this.page = page;
    this.httpErrors = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.steps = [];
    this.previews = [];
    this.previewStarted = 0;
    this.previewDone = 0;
    this.expectedHttp = []; // 4xx that a negative scenario expects
    this._seq = new WeakMap();
    this._stepStart = Date.now();
    this._stepName = 'start';

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      if (this.expectedHttp.some((r) => text.includes(`status of ${r.status}`))) return;
      this.consoleErrors.push(text.slice(0, 300));
    });
    page.on('pageerror', (err) => this.pageErrors.push(String(err.message || err).slice(0, 300)));

    page.on('request', (req) => {
      if (req.method() === 'POST' && isPreview(req.url())) this._seq.set(req, ++this.previewStarted);
    });
    page.on('requestfailed', (req) => {
      const seq = this._seq.get(req);
      if (!seq) return;
      this.previews.push({ seq, status: 0, variant: variantOf(req.url()), request: safeJson(req.postData()), body: null });
      this.previewDone++;
    });
    page.on('response', async (res) => {
      const url = res.url();
      const status = res.status();
      const seq = this._seq.get(res.request());
      if (seq) {
        const body = await res.json().catch(() => null);
        this.previews.push({ seq, status, variant: variantOf(url), request: safeJson(res.request().postData()), body });
        this.previewDone++;
      }
      if (status < 400) return;
      if (!url.includes('api-dev.myndp.kz') && !url.includes('/api/')) return;
      if (IGNORED_HTTP.some((r) => r.status === status && r.url.test(url))) return;
      if (this.expectedHttp.some((r) => r.status === status && r.url.test(url))) return;
      // Recorded synchronously so callers can react right away; the body is filled in later
      const entry = { status, method: res.request().method(), url: url.replace(/^https?:\/\/[^/]+\/api/, ''), body: '' };
      this.httpErrors.push(entry);
      entry.body = (await res.text().catch(() => '')).slice(0, 300);
    });
  }

  expectHttp(status, url) {
    this.expectedHttp.push({ status, url });
  }

  // True when every recalculation the form started has been answered and recorded
  previewsSettled() {
    return this.previewDone >= this.previewStarted;
  }

  // The most recent recalculation the form SENT (by request order), whatever its outcome
  lastPreview() {
    return this.previews.reduce((last, p) => (!last || p.seq > last.seq ? p : last), null);
  }

  step(name) {
    const now = Date.now();
    this.steps.push({ name: this._stepName, ms: now - this._stepStart });
    this._stepName = name;
    this._stepStart = now;
  }

  finish() {
    this.step('end');
    return {
      httpErrors: this.httpErrors,
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
      steps: this.steps.filter((s) => s.name !== 'start' || s.ms > 0),
    };
  }
}

function variantOf(url) {
  return (url.match(/variants\/([a-z_]+)\/preview/) || [])[1];
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- the purchase form ----------

const BASE_URL = 'https://dev.myndp.kz';
const ESBD_SAVE_ERROR = 'Не удалось сохранить клиента в ЕСБД';

// Thrown when the automation itself cannot continue (selector/timeout), as opposed to a product bug.
class FlowError extends Error {
  constructor(step, message) {
    super(`[${step}] ${message}`);
    this.step = step;
  }
}

function parseMoney(s) {
  if (!s) return null;
  const digits = String(s).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function ruDateToIso(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function countLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} человек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} человека`;
  return `${n} человек`;
}

const shown = (text, label) => {
  const v = after(text, label);
  return v == null ? undefined : v.trim();
};

function after(text, label, lines = 1) {
  const all = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const i = all.findIndex((l) => l.startsWith(label));
  return i < 0 ? null : all.slice(i + 1, i + 1 + lines).join(' ');
}

class NsFlow {
  constructor(browser) {
    this.browser = browser;
    this.page = null;
    this.monitor = null;
    this.context = null;
  }

  async open() {
    // The agent's view: Kazakhstan time and Russian locale, whatever the machine running the bot uses
    this.context = await this.browser.newContext({ acceptDownloads: true, timezoneId: 'Asia/Almaty', locale: 'ru-RU' });
    this.page = await this.context.newPage();
    this.monitor = new Monitor(this.page);
    const page = this.page;

    this.monitor.step('login');
    await page.goto(`${BASE_URL}/authorization`);
    await page.click('text="Пароль"');
    await page.waitForSelector('input[placeholder="Введите свой логин"]', { state: 'visible' });
    await page.fill('input[placeholder="Введите свой логин"]', process.env.MYNDP_LOGIN);
    await page.fill('input[placeholder="*****"]', process.env.MYNDP_PASSWORD);
    await page.click('button:has-text("Войти")');
    await page.waitForURL('**/dashboard**', { timeout: 30000 }).catch(() => {
      throw new FlowError('login', 'не удалось войти в dev.myndp.kz');
    });

    this.monitor.step('step1');
    await page.goto(`${BASE_URL}/policies/ns/buy`);
    await page.locator('button', { hasText: 'Купить' }).first().waitFor({ timeout: 20000 });
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
  }

  async text() {
    return this.page.evaluate(() => document.body.innerText);
  }

  async screenshot() {
    return this.page.screenshot({ fullPage: true }).catch(() => null);
  }

  // Outlines in red card rows ({ section, label }) or leaf texts ({ section, text }); returns how many were found
  async markFields(fields) {
    return this.page.evaluate((fields) => {
      const paint = (el) => {
        el.style.outline = '3px solid #e5322d';
        el.style.outlineOffset = '2px';
        el.style.background = 'rgba(229, 50, 45, 0.08)';
      };
      // the nearest card block that starts with a section title must be this section
      const sections = [...new Set(fields.map((f) => f.section))].concat(['Данные по страховому полису', 'Страховые выплаты', 'Данные по страхователю', 'Данные о застрахованных']);
      const inSection = (el, section) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const text = (p.innerText || '').trim();
          const own = sections.find((s) => text.startsWith(s));
          if (own) return own === section;
        }
        return false;
      };
      // a bare text (e.g. a stray «0» next to other elements) gets its own span to be outlined
      const textNodes = (text) => {
        const out = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent.trim() !== text) continue;
          if (!n.parentElement.children.length) out.push(n.parentElement);
          else {
            const span = document.createElement('span');
            n.replaceWith(span);
            span.append(n);
            out.push(span);
          }
        }
        return out;
      };
      let found = 0;
      for (const f of fields) {
        const els = f.label
          ? [...document.querySelectorAll('dt')].filter((dt) => dt.textContent.trim() === f.label).map((dt) => dt.parentElement)
          : textNodes(f.text);
        for (const el of els.filter((e) => inSection(e, f.section))) {
          paint(el);
          found++;
        }
      }
      return found;
    }, fields).catch(() => 0);
  }

  // The «Оформляем полис» window stuck on «Готовим сертификат…», outlined; null when it is not on screen
  async certificateDialogShot() {
    const dialog = this.page.getByRole('dialog', { name: 'Оформляем полис' });
    if (!(await dialog.isVisible().catch(() => false))) return null;
    await dialog.evaluate((el) => { el.style.outline = '3px solid #e5322d'; el.style.outlineOffset = '4px'; }).catch(() => {});
    return this.page.screenshot().catch(() => null);
  }

  // Red banner above the form (calc/validation errors)
  async bannerErrors() {
    const t = await this.text();
    const m = /([^\n]+)\n+\s*Пересчитать/.exec(t);
    return m ? m[1].trim() : null;
  }

  field(label) {
    return this.page.locator(`div.flex-col:has(> span:text-is("${label}")) button`).first();
  }

  // Polls a condition every 50 ms; returns whether it became true in time
  async until(cond, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (!cond() && Date.now() < end) await this.page.waitForTimeout(50);
    return cond();
  }

  // Every recalculation the form has started is answered
  async settle(timeoutMs = 15000) {
    await this.until(() => this.monitor.previewsSettled(), timeoutMs);
  }

  // Runs a change; if it starts a premium recalculation (within ~1 s), waits for that to finish
  async withPreview(action) {
    const before = this.monitor.previewStarted;
    await action();
    await this.until(() => this.monitor.previewStarted > before, 1200);
    await this.settle();
  }

  async pick(label, value) {
    const current = await this.field(label).innerText().then((t) => t.trim(), () => '');
    if (current === value) return; // already set: no click, no waiting
    await this.withPreview(async () => {
      await this.field(label).click();
      const option = this.page.getByText(value, { exact: true }).last();
      await option.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
        throw new FlowError('step1', `в списке «${label}» нет значения «${value}»`);
      });
      await option.click();
    });
  }

  // ---------- Step 1 ----------

  // Sets EVERY parameter explicitly (no reliance on form defaults) and reads back what the form holds.
  // exp: { variant, contractType, count, amount, term, startDate, sportTypes, roles }
  async selectParams(c) {
    const page = this.page;
    // Program: the sport form has a «Виды спорта» field, the standard one does not
    const sportShown = await this.field('Виды спорта').isVisible().catch(() => false);
    if ((c.variant === 'sport') !== sportShown) {
      await this.withPreview(() => page.getByText(c.variant === 'sport' ? 'НС Спорт' : 'НС Стандарт', { exact: true }).first().click({ force: true }));
    }
    const category = c.contractType === 'children' ? 'Дети' : 'Взрослые';
    const categoryRadio = page.locator('button[role="radio"]', { hasText: category }).first();
    if ((await categoryRadio.getAttribute('aria-checked').catch(() => null)) !== 'true') {
      await this.withPreview(() => page.getByText(category, { exact: true }).first().click({ force: true }));
    }

    await this.pick('Количество застрахованных', countLabel(c.count || 1));
    if (c.amount) await this.pick('Сумма страхования', c.amount);
    if (c.term) await this.pick('Срок страхования', c.term);
    if (c.startDate && c.term !== 'Произвольный') await this.setStartDate(c.startDate);

    if (c.variant === 'sport') {
      if (c.sportTypes && c.sportTypes.length) {
        await this.field('Виды спорта').click();
        for (const s of c.sportTypes) {
          await this.withPreview(() => page.getByText(s, { exact: true }).last().click());
        }
        await this.field('Виды спорта').click({ force: true });
        await page.waitForTimeout(400);
      }
      for (const [i, role] of (c.roles || []).entries()) {
        if (!role || role === 'Спортсмен') continue;
        await this.pick(`Застрахованный ${i + 1}`, role);
      }
    }
    await this.settle();
    return this.readStep1(category);
  }

  async setStartDate(iso) {
    const input = this.page.locator('input[placeholder="дд.мм.гггг"]').first();
    const ru = iso.split('-').reverse().join('.');
    if ((await input.inputValue().catch(() => '')) === ru) return;
    await this.withPreview(async () => {
      await input.click();
      await input.fill(ru);
      await input.press('Enter');
      await this.page.keyboard.press('Escape').catch(() => {});
    });
  }

  // What the form holds right now: visible values + the last request the form sent to the calculator
  async readStep1(category = 'Взрослые') {
    const t = await this.text();
    const fieldText = (label) => this.field(label).innerText().then((s) => s.trim(), () => null);
    const preview = this.monitor.lastPreview();
    return {
      premium: parseMoney(after(t, 'Предварительный расчет на')),
      startDate: ruDateToIso(await this.page.locator('input[placeholder="дд.мм.гггг"]').first().inputValue().catch(() => '')),
      endDate: ruDateToIso(await this.page.locator('input[placeholder="дд.мм.гггг"]').nth(1).inputValue().catch(() => '')),
      categoryChecked: await this.page.locator('button[role="radio"]', { hasText: category }).first().getAttribute('aria-checked').catch(() => null),
      count: await fieldText('Количество застрахованных'),
      amount: await fieldText('Сумма страхования'),
      term: await fieldText('Срок страхования'),
      previewVariant: preview && preview.variant,
      previewRequest: preview && preview.request,
      banner: await this.bannerErrors(),
    };
  }

  // Returns true if the form moved to step 2
  async buy() {
    this.monitor.step('step2-contacts');
    await this.page.locator('button', { hasText: 'Купить' }).first().click();
    return this.page.locator('input[placeholder="+7(777)777-77-77"]')
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  }

  // ---------- Step 2 ----------

  async fillContacts(phone, email) {
    const page = this.page;
    const phoneInput = page.locator('input[placeholder="+7(777)777-77-77"]');
    await phoneInput.fill('');
    if (phone) await phoneInput.fill(phone);
    const emailInput = page.locator('input[placeholder="Введите почту"]');
    await emailInput.fill('');
    if (email) await emailInput.fill(email);
    await page.locator('button', { hasText: 'Далее' }).first().click();
    const passed = await page.locator('input[placeholder="Введите ИИН"]').first()
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    return { passed, text: passed ? after(await this.text(), 'Ваши данные', 2) : null };
  }

  clientModal() {
    return this.page.getByRole('dialog', { name: 'Просим уточнить ваши данные' }).last();
  }

  // Types an IIN into an input and waits for the GBD lookup outcome
  async lookupIin(input, iin, timeout = 60000, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const errorsBefore = this.monitor.httpErrors.length;
      const outcome = await this._lookupOnce(input, iin, timeout);
      await this.page.waitForTimeout(300);
      const kdpDown = this.monitor.httpErrors.slice(errorsBefore).some((e) => e.status >= 500 && /\/kdp\//.test(e.url));
      if (!kdpDown) return outcome;
      if (attempt >= retries) return 'kdp_unavailable';
      // Close the "fill manually" modal that the failed lookup opened, then try again
      const modal = this.clientModal();
      if (await modal.isVisible().catch(() => false)) await modal.locator('button').first().click().catch(() => {});
      await this.page.waitForTimeout(10000);
    }
  }

  async _lookupOnce(input, iin, timeout) {
    this.monitor.step('gbd-lookup');
    await input.fill('');
    await input.fill(iin);
    const page = this.page;
    const outcome = await Promise.race([
      page.getByText('Данные клиента загружены').last().waitFor({ state: 'visible', timeout }).then(() => 'found'),
      this.clientModal().waitFor({ state: 'visible', timeout }).then(() => 'not_found'),
    ]).catch(() => 'no_reaction');
    // Small grace period: the "not found" modal may follow the spinner
    if (outcome === 'found') await page.waitForTimeout(500);
    return outcome;
  }

  // Confirms the "Просим уточнить ваши данные" modal, retrying the flaky ESBD save
  async confirmClientModal(maxAttempts = 3) {
    const modal = this.clientModal();
    let esbdErrors = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const errorsBefore = this.monitor.httpErrors.length;
      await modal.locator('button', { hasText: 'Подтвердить' }).last().click();
      // Closed — or the save already failed on the server (no need to wait the full 20 s then)
      const saveFailed = () => this.monitor.httpErrors.slice(errorsBefore).some((e) => /\/kdp\/save/.test(e.url));
      let closed = false;
      for (const end = Date.now() + 20000; Date.now() < end;) {
        if (!(await modal.isVisible().catch(() => false))) { closed = true; break; }
        if (saveFailed()) break;
        await this.page.waitForTimeout(200);
      }
      if (closed) return { ok: true, esbdErrors };
      await this.page.waitForTimeout(500); // let the modal show the error text
      const t = await modal.innerText().catch(() => '');
      if (t.includes(ESBD_SAVE_ERROR)) {
        esbdErrors++;
        await this.page.waitForTimeout(3000);
        continue;
      }
      const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
      const err = lines.find((l) => /(обязательн|ошибк|не удалось|должен|некоррект|invalid|must|required)/i.test(l));
      if (err) return { ok: false, esbdErrors, error: err };
      // No visible error: the save is just slow — wait and try again
      esbdErrors++;
      await this.page.waitForTimeout(3000);
    }
    return { ok: false, esbdErrors, error: `клиент не сохранился за ${maxAttempts} попытки (ЕСБД не отвечает или ${ESBD_SAVE_ERROR})` };
  }

  async setHolder(iin, { insured = true } = {}) {
    const page = this.page;
    const input = page.locator('input[placeholder="Введите ИИН"]').first();
    const lookup = await this.lookupIin(input, iin);
    if (lookup !== 'found') return { lookup };

    const box = page.locator('div:has(> span:has-text("Будет в списке застрахованных")) > button[role="checkbox"]').first();
    if ((await box.getAttribute('aria-checked').catch(() => null)) !== String(insured)) {
      await this.withPreview(() => box.click());
    }
    const holderInsured = (await box.getAttribute('aria-checked').catch(() => null)) === 'true';

    this.monitor.step('holder-confirm');
    await page.locator('button', { hasText: 'Подтвердить' }).first().click();
    await this.clientModal().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      throw new FlowError('holder', 'после «Подтвердить» не открылась модалка с данными клиента');
    });
    const confirm = await this.confirmClientModal();
    await this.settle(); // the premium is recalculated with the real age
    return { lookup, holderInsured, ...confirm };
  }

  // Fills the last empty "Застрахованный N" slot. person: { iin, lastName, firstName, gender, birthDate, docNumber, docDate }
  async addInsured(person, { addSlot = false } = {}) {
    const page = this.page;
    this.monitor.step('insured');
    if (addSlot) {
      await page.locator('button', { hasText: 'Добавить застрахованного' }).click();
      await page.waitForTimeout(800);
    }
    // the first slot whose IIN field is still empty (with 3+ insured the last field is not the next one)
    const inputs = page.locator('input[placeholder="Введите ИИН"]');
    await inputs.last().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      throw new FlowError('insured', 'нет пустого слота застрахованного с полем ИИН');
    });
    let input = null;
    for (let i = 0, n = await inputs.count(); i < n && !input; i++) {
      if ((await inputs.nth(i).inputValue().catch(() => 'x')) === '') input = inputs.nth(i);
    }
    if (!input) throw new FlowError('insured', 'все поля ИИН застрахованных уже заполнены');
    // this slot's own «Подтвердить» (with 3+ insured the last one on the page belongs to the next, empty slot)
    const slotConfirm = await input.evaluateHandle((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const b = [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Подтвердить');
        if (b) return b;
      }
      return null;
    });
    const lookup = await this.lookupIin(input, person.iin);
    let manual = null;

    if (lookup === 'not_found') {
      manual = await this.fillManual(person);
      if (!manual.ok) return { lookup, manual };
    }

    // A manually entered person usually collapses the slot at once; otherwise confirm it with the slot's button
    const btn = slotConfirm.asElement();
    if (btn && (await btn.evaluate((b) => b.isConnected && b.offsetParent !== null).catch(() => false))) {
      await btn.click();
      const modalOpened = await this.clientModal().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
      if (modalOpened) {
        const confirm = await this.confirmClientModal();
        return { lookup, manual, ...confirm };
      }
    }
    await page.waitForTimeout(800);
    return { lookup, manual, ok: true };
  }

  async fillManual(person) {
    const page = this.page;
    this.monitor.step('manual-entry');
    const modal = this.clientModal();
    const manualBtn = modal.locator('button', { hasText: 'Заполнить данные вручную' });
    if (await manualBtn.isVisible().catch(() => false)) await manualBtn.click();
    await page.waitForTimeout(800);

    const inputs = modal.locator('input');
    const fill = async (i, v) => { if (v != null) await inputs.nth(i).fill(v); };
    const toRu = (iso) => iso.split('-').reverse().join('.');

    // Field order observed on dev: last name, first name, birth date, doc number, doc date, issued-by
    await fill(0, person.lastName);
    await fill(1, person.firstName);
    await fill(2, toRu(person.birthDate));
    await fill(3, person.docNumber);
    await fill(4, toRu(person.docDate));
    await fill(5, person.issuedBy || 'МВД РК');

    const choose = async (options) => {
      const trigger = modal.locator('button', { hasText: 'Выберите из списка' }).first();
      if (!(await trigger.isVisible().catch(() => false))) return null;
      await trigger.click();
      await page.waitForTimeout(400);
      for (const o of options) {
        const opt = page.getByText(o, { exact: true }).last();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click();
          await page.waitForTimeout(300);
          return o;
        }
      }
      await trigger.click({ force: true });
      return null;
    };
    const gender = await choose(person.gender === 'female' ? ['Женский'] : ['Мужской']);
    const docType = await choose(person.docTypes || ['Удостоверение личности', 'Свидетельство о рождении', 'Паспорт']);

    const confirm = await this.confirmClientModal();
    return { ...confirm, gender, docType };
  }

  async insuredNames() {
    const t = await this.text();
    const block = t.split('Застрахованные')[1] || '';
    return [...block.matchAll(/\n([А-ЯЁA-Z][А-ЯЁA-Z\- ]+)\n(Страхователь \/ )?Застрахованный (\d+)/g)].map((m) => m[1].trim());
  }

  // Returns true if the form moved to step 3
  async toStep3() {
    this.monitor.step('step3');
    await this.page.locator('button', { hasText: 'Далее' }).last().click();
    const step3 = this.page.getByText('Шаг 3 из 3');
    const t0 = Date.now();
    for (const end = t0 + 15000; Date.now() < end;) {
      if (await step3.isVisible().catch(() => false)) return true;
      // An error banner that is still there after the click means the form refused to move on
      if (Date.now() - t0 > 1500 && (await this.bannerErrors())) return false;
      await this.page.waitForTimeout(200);
    }
    return false;
  }

  async readStep3() {
    // The price block on step 3 renders after the rest of the summary
    await this.settle();
    await this.page.getByText('Итого к оплате').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const t = await this.text();
    const period = after(t, 'Срок действия') || '';
    const [start, end] = period.split('-').map((s) => ruDateToIso(s));
    const participants = (t.split('Участники')[1] || '').split('Страховые выплаты')[0]
      .split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      startDate: start,
      endDate: end,
      amount: parseMoney(after(t, 'Страховая сумма в тенге')),
      premium: parseMoney(after(t, 'Страховая премия в тенге') || after(t, 'Страховая премия')),
      total: parseMoney(after(t, 'Итого к оплате')),
      participants,
    };
  }

  // Downloads the application form; returns { ok, size, isPdf, issueEnabled }
  async printAnketa() {
    const page = this.page;
    this.monitor.step('anketa');
    const printModal = page.getByRole('dialog', { name: 'Печать анкеты' });
    // the first click sometimes does nothing while step 3 is still settling — click once more
    for (let attempt = 1; ; attempt++) {
      await page.getByText('Печать анкеты', { exact: true }).first().click({ force: true });
      const shown = await printModal.waitFor({ state: 'visible', timeout: attempt === 1 ? 8000 : 15000 }).then(() => true, () => false);
      if (shown) break;
      if (attempt === 2) throw new FlowError('anketa', 'окно «Печать анкеты» не открылось после двух нажатий');
    }
    const anketaBtn = printModal.locator('button', { hasText: /Анкета заявления и КИД[\s\S]*KB/ });
    // Ready, or the print service already said no — no point waiting the full minute then
    const printFailed = () => this.monitor.httpErrors.find((e) => /documents\/combined\/print/.test(e.url));
    let decided = false;
    const ready = await Promise.race([
      anketaBtn.waitFor({ state: 'visible', timeout: 60000 }).then(() => true, () => false),
      this.until(() => decided || !!printFailed(), 60000).then(() => (printFailed() ? false : new Promise(() => {}))),
    ]);
    decided = true;
    if (!ready) {
      const issueBtn = printModal.locator('button', { hasText: 'Выписать полис' });
      const issueEnabledWithoutAnketa = !(await issueBtn.isDisabled().catch(() => true));
      const failed = printFailed();
      return { ok: false, error: failed ? `сервис печати ответил ${failed.status}` : 'документы не сформировались за 60 с', issueEnabledWithoutAnketa };
    }

    const issueBtn = printModal.locator('button', { hasText: 'Выписать полис' });
    const enabledBefore = !(await issueBtn.isDisabled().catch(() => true));

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), anketaBtn.click()]);
    const file = await download.path();
    const buf = file ? await fs.readFile(file) : Buffer.alloc(0);
    await download.delete().catch(() => {});

    // The button unlocks once the site registers the download
    const enabledAfter = await page.waitForFunction((el) => el && !el.disabled, await issueBtn.elementHandle(), { timeout: 3000 })
      .then(() => true, () => false);
    return {
      ok: true,
      size: buf.length,
      isPdf: buf.slice(0, 4).toString() === '%PDF',
      fileName: download.suggestedFilename(),
      issueEnabledBefore: enabledBefore,
      issueEnabledAfter: enabledAfter,
    };
  }

  // Opens the payment method modal; returns { options, total }
  async openPayment() {
    const page = this.page;
    this.monitor.step('payment');
    const printModal = page.getByRole('dialog', { name: 'Печать анкеты' });
    await printModal.locator('button', { hasText: 'Выписать полис' }).click();
    const pay = page.getByRole('dialog', { name: 'Способ оплаты' });
    await pay.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {
      throw new FlowError('payment', 'не открылась модалка «Способ оплаты»');
    });
    const t = await pay.innerText();
    const options = ['Наличный расчёт', 'Картой онлайн', 'QR Kaspi', 'Ссылка на оплату', 'Счёт в Kaspi.kz'].filter((o) => t.includes(o));
    return { options, total: parseMoney(after(t, 'Итого к оплате')) };
  }

  // Final, irreversible step. Before the request leaves the browser it is checked against `expectBody`;
  // a mismatch aborts the request (nothing is created). The process id from the answer is journaled at once.
  // expectBody: { variant, contract_type, insurance_amount, start_at, end_at, holderIin, insuredIins, sport_types, professionsByIin }
  async issueCash({ expectBody, journal, journalEntry }) {
    const page = this.page;
    const pay = page.getByRole('dialog', { name: 'Способ оплаты' });
    await pay.getByText('Наличный расчёт').first().click();

    const guard = { mismatches: null, body: null };
    await page.route('**/v1/ui/policy/v1/ns/policies', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      let body = null;
      try { body = JSON.parse(route.request().postData() || 'null'); } catch { body = null; }
      guard.body = body;
      guard.mismatches = compareIssueBody(body, expectBody);
      if (guard.mismatches.length) return route.abort('blockedbyclient');
      return route.continue();
    });

    this.monitor.step('issue');
    const answer = page.waitForResponse((r) => r.url().endsWith('/ns/policies') && r.request().method() === 'POST', { timeout: 30000 }).catch(() => null);
    await pay.locator('button', { hasText: 'Выписать полис' }).click();
    const res = await answer;
    await page.unroute('**/v1/ui/policy/v1/ns/policies').catch(() => {});

    if (guard.mismatches && guard.mismatches.length) {
      await journal.resolve(journalEntry, { status: 'blocked', reason: guard.mismatches });
      throw new FlowError('pre-issue', `запрос выписки не совпал с заданными параметрами и НЕ отправлен: ${guard.mismatches.join('; ')}`);
    }
    if (!guard.body) throw new FlowError('issue', 'запрос выписки не перехвачен — результат будет выяснен по журналу');
    if (!res) {
      await journal.unanswered(journalEntry, 'no_response', 'ответ на POST /ns/policies не получен');
      throw new FlowError('issue', 'ответ на создание заявки не получен — результат неизвестен, выписка этого сценария заблокирована до выяснения');
    }
    const json = await res.json().catch(() => null);
    const processId = json && json.data && json.data.process_instance_id;
    if (!processId) {
      const status = res.status();
      // 4xx = the server refused (nothing created); anything else may have created a policy
      if (status >= 400 && status < 500) await journal.resolve(journalEntry, { status: `rejected_${status}`, error: JSON.stringify(json).slice(0, 300) });
      else await journal.unanswered(journalEntry, status, JSON.stringify(json).slice(0, 300));
      throw new FlowError('issue', `сервер не вернул process_instance_id (HTTP ${status})${status >= 500 || status < 400 ? ' — результат неизвестен, выписка заблокирована до выяснения' : ''}`);
    }
    await journal.submitted(journalEntry, processId);
    if (process.env.NS_TEST_CRASH_AFTER_SUBMIT) throw new Error('NS_TEST_CRASH_AFTER_SUBMIT: имитация падения сразу после отправки');
    return { processId };
  }

  // Contract card in «Мои полисы» (/policies/{policy id})
  async openCard(policyId) {
    const page = this.page;
    this.monitor.step('card');
    await page.goto(`${BASE_URL}/policies/${policyId}`);
    const ok = await page.getByText(/^Договор №/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!ok) return null;
    await page.getByText('Данные о застрахованных').first().waitFor({ timeout: 10000 }).catch(() => {});
    const t = await this.text();
    const holderPart = (t.split('Данные по страхователю')[1] || '').split('Данные о застрахованных')[0];
    const insuredPart = t.split('Данные о застрахованных')[1] || '';
    const lines = insuredPart.split('\n').map((l) => l.trim()).filter(Boolean);
    const insuredIins = lines.filter((l, i) => lines[i - 1] === 'ИИН' && /^\d{12}$/.test(l));
    const val = (s) => (s && s.trim() !== '—' ? s.trim() : null);
    return {
      number: val(after(t, 'Номер полиса')),
      status: val(after(t, 'Текущий статус')),
      program: val(after(t, 'Программа страхования')),
      startDate: ruDateToIso(after(t, 'Начало срока действия')),
      endDate: ruDateToIso(after(t, 'Окончание срока действия')),
      amount: parseMoney(after(t, 'Страховая сумма')),
      premium: parseMoney(after(t, 'Страховая премия в тенге')),
      holderName: val(after(holderPart, 'Полное имя')),
      holderIin: val(after(holderPart, 'ИИН / БИН')),
      insuredIins,
      // as shown on the page: '—' = the row is there but empty; undefined = no such row
      holderIinShown: shown(holderPart, 'ИИН / БИН'),
      holderBirthShown: shown(holderPart, 'Дата рождения'),
      holderDocShown: shown(holderPart, 'Документ'),
      insuredNameShown: shown(insuredPart, 'Полное имя'),
      insuredDocShown: shown(insuredPart, 'Документ'),
      insuredStrayZero: lines.includes('0'),
    };
  }

  // How long the "Готовим сертификат…" spinner takes (UI side), capped
  async waitCertificateUi(limitMs) {
    this.monitor.step('certificate-ui');
    const spinner = this.page.getByRole('dialog', { name: 'Оформляем полис' }).getByText(/^Готовим сертификат/);
    const t0 = Date.now();
    const done = await spinner.waitFor({ state: 'hidden', timeout: limitMs }).then(() => true, (e) => {
      if (e.name !== 'TimeoutError') throw e;
      return false;
    });
    return { done, ms: Date.now() - t0, limitMs };
  }
}

// What the browser is about to send vs what the scenario asked for. Returns a list of mismatches.
function compareIssueBody(body, exp) {
  if (!body) return ['тело запроса не прочитано'];
  const out = [];
  const same = (name, got, want) => { if (want !== undefined && got !== want) out.push(`${name}: ${got} ≠ ${want}`); };
  same('variant', body.variant, exp.variant);
  same('contract_type', body.contract_type, exp.contract_type);
  same('insurance_amount', body.insurance_amount, exp.insurance_amount);
  same('start_at', body.start_at, exp.start_at);
  same('end_at', body.end_at, exp.end_at);
  same('payment_method', body.payment_method, 'cash');
  same('policyholder.iin', body.policyholder && body.policyholder.iin, exp.holderIin);
  const got = (body.insureds || []).map((i) => i.iin).sort().join(',');
  const want = [...(exp.insuredIins || [])].sort().join(',');
  if (exp.insuredIins && got !== want) out.push(`insureds: ${got} ≠ ${want}`);
  if (exp.sport_types) {
    const gotSports = [...(body.sport_types || [])].sort().join(',');
    const wantSports = [...exp.sport_types].sort().join(',');
    if (gotSports !== wantSports) out.push(`sport_types: ${gotSports || '—'} ≠ ${wantSports}`);
  }
  if (exp.professionsByIin) {
    for (const i of body.insureds || []) {
      const want = exp.professionsByIin[i.iin];
      if (want && i.profession !== want) out.push(`profession ${i.iin}: ${i.profession || '—'} ≠ ${want}`);
    }
  }
  return out;
}

module.exports = { NsFlow, FlowError, BASE_URL, parseMoney, ruDateToIso, countLabel, compareIssueBody };
