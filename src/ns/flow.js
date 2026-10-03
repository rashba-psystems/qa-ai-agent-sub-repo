'use strict';

// The NS (accident insurance) form: step 1 (program, category, count, amount, term, start date, sports and roles),
// manual entry of an insured person, the issuance-request guard — and the form validation scenarios
// (`web ns ошибки`). What every product shares is in src/insurance/flow.js.

const { PurchaseFlow, FlowError, parseMoney, ruDateToIso, after } = require('../insurance/flow');
const { check, isEnglish } = require('../insurance/checks');
const { runScenario, launchBrowser, withBadChecksum, client } = require('../insurance/purchase');
const { byRule } = require('./checks');
const { negativeCases, countLabel } = require('./cases');

class NsFlow extends PurchaseFlow {
  constructor(browser) {
    super(browser, { product: 'ns' });
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
}

// ---------- form validation scenarios (`web ns ошибки`): each returns checks, none ever issues ----------

// ---------- form validation scenarios (`web ns ошибки`): each returns checks, none ever issues ----------

async function toContacts(flow, c) {
  await flow.selectParams(c);
  if (!(await flow.buy())) throw new FlowError('step1', '«Купить» не перевела на шаг 2');
}

async function toHolder(flow, c, client) {
  await toContacts(flow, c);
  const r = await flow.fillContacts(client.phone, client.email);
  if (!r.passed) throw new FlowError('contacts', 'валидные контакты не приняты');
}

// Text directly under the "ИИН страхователя" input: a hint/error, or the next field label if none
async function iinHint(flow) {
  const t = await flow.text();
  const lines = (t.split('ИИН страхователя')[1] || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines[0] && !/^(Будет в списке|Принадлежность)/.test(lines[0]) ? lines[0] : null;
}

async function badIin(flow, c, client, iin) {
  await toHolder(flow, c, client);
  const input = flow.page.locator('input[placeholder="Введите ИИН"]').first();
  const outcome = await flow.lookupIin(input, iin, 12000);
  const hint = await iinHint(flow);
  return [
    check('Клиент по невалидному ИИН не загружен', outcome !== 'found', 'не найден', outcome),
    byRule('iin-error-hint', 'Под полем ИИН показана ошибка', !!hint && !/загружены/.test(hint), 'сообщение об ошибке', hint || '(нет сообщения)'),
  ];
}

const negatives = {
  async N01(flow, c) {
    await flow.selectParams(c);
    const passed = await flow.buy();
    const t = await flow.text();
    return [
      byRule('amount-dictionary', 'Без суммы нельзя перейти на шаг 2', !passed, 'остаёмся на шаге 1', passed ? 'перешли на шаг 2' : 'шаг 1'),
      check('Показана подсказка «Выберите страховую сумму»', t.includes('Выберите страховую сумму'), 'подсказка', t.includes('Выберите страховую сумму') ? 'есть' : 'нет', 'note'),
    ];
  },

  async N02(flow, c) {
    await toContacts(flow, c);
    const r = await flow.fillContacts('', '');
    return [byRule('contacts-required', 'Пустые телефон и email не пропускаются', !r.passed, 'остаёмся на контактах', r.passed ? `пропустило дальше («${r.text}»)` : 'заблокировано')];
  },

  async N03(flow, c) {
    await toContacts(flow, c);
    const r = await flow.fillContacts('123', 'not-an-email');
    return [byRule('contacts-valid', 'Телефон «123» и email «not-an-email» не пропускаются', !r.passed, 'остаёмся на контактах', r.passed ? `пропустило дальше («${r.text}»)` : 'заблокировано')];
  },

  async N04(flow, c, client) {
    return badIin(flow, c, client, withBadChecksum(client.iin));
  },

  async N05(flow, c, client) {
    return badIin(flow, c, client, '12345');
  },

  async N06(flow, c, client) {
    flow.monitor.expectHttp(422, /\/preview/);
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const reached = await flow.toStep3();
    const banner = await flow.bannerErrors();
    return [
      byRule('age-children', 'Взрослый не проходит застрахованным в «Дети»', !reached, 'блокировка на шаге 2', reached ? 'дошли до шага 3' : 'заблокировано'),
      check('Ошибка возраста показана пользователю', !!banner, 'сообщение', banner || '(нет)', 'note'),
      byRule('errors-russian', 'Ошибка возраста на русском языке', !isEnglish(banner), 'русский текст', banner || '(нет)'),
    ];
  },

  async N07(flow, c, client) {
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const ins = await flow.addInsured({ iin: client.iin });
    const names = await flow.insuredNames();
    const reached = ins.ok !== false ? await flow.toStep3() : false;
    const participants = reached ? (await flow.readStep3()).participants.join(' | ') : null;
    return [
      byRule('no-duplicate-insured', 'Один ИИН нельзя добавить застрахованным дважды', !reached, 'блокировка', reached ? `дошли до шага 3: ${participants}` : `заблокировано (${ins.error || 'на шаге 2'})`),
      byRule('no-duplicate-insured', 'Список застрахованных без дублей', new Set(names).size === names.length, 'уникальные', names.join(', ')),
    ];
  },

  async N08(flow, c, client) {
    flow.monitor.expectHttp(422, /\/preview/);
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const person = c.insureds[0];
    const ins = await flow.addInsured(person);
    if (ins.lookup === 'no_reaction') throw new FlowError('insured', 'форма не отреагировала на ИИН застрахованного');
    const reached = ins.ok !== false ? await flow.toStep3() : false;
    const banner = await flow.bannerErrors();
    return [
      byRule('age-adult', `Застрахованный ${person.birthDate} (17 лет) не проходит во «Взрослые»`, !reached, 'блокировка', reached ? 'дошли до шага 3' : `заблокировано (${ins.error || banner || 'шаг 2'})`),
    ];
  },

  // The manual form has no Latin name fields, yet the backend needs them for a passport
  async N09(flow, c, client) {
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const ins = await flow.addInsured(c.insureds[0]);
    if (ins.lookup !== 'not_found') throw new FlowError('insured', `ожидали ручной ввод, а ГБД ответила: ${ins.lookup}`);
    const m = ins.manual || {};
    const saved = m.ok === true;
    return [
      byRule('manual-passport', 'Клиента с паспортом можно сохранить вручную', saved, 'сохранён', saved ? 'сохранён' : m.error),
      byRule('errors-russian', 'Ошибка ручного ввода на русском', saved || !isEnglish(m.error), 'русский текст', m.error || '—'),
      check('Выбран тип документа «Паспорт»', m.docType === 'Паспорт', 'Паспорт', m.docType || '(не выбран)', 'note'),
    ];
  },
};

async function runNegatives({ onProgress = async () => {} } = {}) {
  const results = [];
  const browser = await launchBrowser();
  try {
    for (const [i, c] of negativeCases.entries()) {
      await onProgress({ done: i, total: negativeCases.length, current: `${c.id} ${c.title}` });
      results.push(await runScenario(new NsFlow(browser), c, async (flow) => ({ checks: await negatives[c.id](flow, c, client) })));
    }
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { NsFlow, runNegatives };
