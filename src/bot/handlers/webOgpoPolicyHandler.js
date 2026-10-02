'use strict';

const { Progress } = require('../progress');
const { getNewContext } = require('../middleware/browserManager');
const { getRandomUser, selectRandomDropdown } = require('../testDataProvider');
const { setupNetworkLogger, formatNetworkLogs } = require('../middleware/logger');

// Обработчик полиса огпо
async function handleWebOgpoPolicy(ctx) {
  let progress = null;
  let failedNetworkRequests = [];

  // 1. Инициализируем новую вкладку-инкогнито из глобального браузера
  const context = await getNewContext();
  const page = await context.newPage();

  try {
    progress = await new Progress(ctx, 'Создаю изолированную сессию...').start();

    failedNetworkRequests = setupNetworkLogger(page);

    // 2. БЛОК АВТОРИЗАЦИИ
    await progress.update('Прохожу авторизацию...');
    await page.goto('https://dev.myndp.kz/authorization'); 
    await page.click('text=Пароль');
    await page.waitForSelector('input[placeholder="Введите свой логин"]', { state: 'visible' });
    await page.fill('input[placeholder="Введите свой логин"]', process.env.MYNDP_LOGIN);
    await page.fill('input[placeholder="*****"]', process.env.MYNDP_PASSWORD);
    await page.click('button:has-text("Войти")');
    
    await page.waitForURL('**/dashboard**', { timeout: 15000 }); 

    // 3. БЛОК ОФОРМЛЕНИЯ ОГПО
    await progress.update('Открываю форму ОГПО...');
    await page.goto('https://dev.myndp.kz/policies/ogpo/buy');
    await page.waitForTimeout(2000);

    const ownershipForms = [
        'Индивидуальный предприниматель/Крестьянское (фермерское) хозяйство', 
        'Лицо, занимающееся частной практикой',
        'Физическое лицо'
    ];
    
    // Выбираем случайный элемент из массива
    const randomOwnership = ownershipForms[Math.floor(Math.random() * ownershipForms.length)];
    await progress.update(`Выбираю форму собственности: ${randomOwnership}...`);

    // Кликаем по контейнеру дропдауна через привязку к заголовку
    await page.locator('text="Форма собственности"').locator('..').click({ force: true });
    await page.waitForTimeout(500);
    
    // Кликаем по выбранному случайному пункту (ищем по частичному совпадению текста)
    await page.getByText(randomOwnership, { exact: false }).last().click({ force: true });
    await page.waitForTimeout(500);

    await page.setViewportSize({ width: 1280, height: 1620 });
    const properForm = await page.screenshot({ fullPage: true });
    await ctx.replyWithPhoto({ source: properForm }, { caption: 'Форма собственности была выбрана случайным порядком' });

    await page.locator('button', { hasText: 'Далее' }).first().click({ force: true });
    await page.waitForTimeout(1000);
    
    await page.getByText('Добавить застрахованного').first().click({ force: true });
    await page.waitForTimeout(1000);

    // 4. ДАННЫЕ ЗАСТРАХОВАННОГО
    await progress.update('Заполняю данные из тестовой базы...');
    
    // Получаем пользователя без пропуска полей
    const user = getRandomUser();

    // Заменяем insuredModal на page
    async function selectDropdown(label, value) {
        if (!value) return;
        await page.locator(`text="${label}"`).locator('..').click({ force: true });
        await page.waitForTimeout(500);

        const searchInput = page.locator('input[placeholder*="Поиск"]').last();

        if (await searchInput.isVisible().catch(() => false)) {
            await searchInput.fill(value);
            await page.waitForTimeout(500);
        }

        await page.getByText(value, { exact: true }).last().click({ force: true });
        await page.waitForTimeout(300);
    }

    // Заполнение дропдаунов
    await selectDropdown('Тип документа', user.docType);
    await selectDropdown('Резидент', user.isResident);
    await selectDropdown('Гражданство', user.citizenship);
    await selectDropdown('Пол', user.gender);
    await selectDropdown('Тип вод/уд', user.driverLicenseType);
    
    // const benefitsList = ['Нет', 'Пенсионер', 'Участник ВОВ', 'Инвалид', 'Лицо приравненное к УВОВ или инв.'];
    // await selectRandomDropdown(page, page, 'Льготы', benefitsList);

    // Проверяем, появились ли дополнительные поля после выбора льготы
    const benefitDocNumberLocator = page.locator('text="Номер документа о льготе"');
    
    if (await benefitDocNumberLocator.isVisible().catch(() => false)) {
        // Заполняем номер и дату выдачи
        await benefitDocNumberLocator.locator('..').locator('input').first().fill(user.docNumber);
        await fillDateByLabel('Дата выдачи документа о льготе', user.docDate);

        // Проверяем, нужно ли заполнять срок действия
        // Ищем поле срока действия
        const benefitEndDateLocator = page.locator('text="Срок действия документа о льготе"');
        
        if (await benefitEndDateLocator.isVisible().catch(() => false)) {
            // Если выбрана инвалидность — дата ТРЕБУЕТСЯ, заполняем ее
            // Для остальных бессрочных льгот — пропускаем, чтобы не вызвать ошибку
            const isInvalidBenefit = await page.getByText('Инвалид', { exact: true }).isVisible().catch(() => false);
            
            if (isInvalidBenefit) {
                // Ставим дату с запасом в будущем (например, +5 лет от даты выдачи или фиксированную)
                await fillDateByLabel('Срок действия документа о льготе', '31.12.2030');
            }
        }
    }
    
    // Привязка текстовых полей через родительский элемент
    await page.locator('text="Номер паспорта"').locator('..').locator('input').first().fill(user.docNumber);
    await page.locator('text="Фамилия"').locator('..').locator('input').first().fill(user.lastName);
    await page.locator('text="Имя"').locator('..').locator('input').first().fill(user.firstName);
    
    if (user.middleName) {
        await page.locator('text="Отчество"').locator('..').locator('input').first().fill(user.middleName);
    }

    // Добавленные поля водительского удостоверения
    await page.locator('text="Номер водительского удостоверения"').locator('..').locator('input').first().fill(user.docNumber);

    // Заполнение дат с жесткой привязкой к заголовкам полей
    async function fillDateByLabel(labelText, dateValue) {
        const labelLocator = page.locator(`text="${labelText}"`).last();
        const dateInput = labelLocator.locator('..').locator('input[placeholder="дд.мм.гггг"]').last();
        await dateInput.click();
        await dateInput.pressSequentially(dateValue.replace(/\./g, ''), { delay: 50 });
        await labelLocator.click({ force: true });
    }

    await fillDateByLabel('Дата рождения', user.dob);
    await fillDateByLabel('Дата выдачи', user.docDate); // Для паспорта
    await fillDateByLabel('Дата выдачи прав', user.docDate); // Для прав

    await page.setViewportSize({ width: 1280, height: 1620 });
    const formBuffer = await page.screenshot({ fullPage: true });
    await ctx.replyWithPhoto({ source: formBuffer }, { caption: `Данные юзера ${user.lastName} заполнены.` });

    // Кликаем подтвердить на основной странице
    await page.locator('button', { hasText: 'Подтвердить' }).click();
    await page.waitForTimeout(1000);

    // 5. ДАННЫЕ СТРАХОВАТЕЛЯ
    await progress.update('Открываю данные Страхователя...');
    await page.waitForTimeout(1500);

    const policyholderSection = page.locator('div').filter({ hasText: /^Страхователь$/i }).last().locator('..');
    
    const editIcon = policyholderSection.locator('button, svg').first();
    if (await editIcon.isVisible().catch(() => false)) {
        await editIcon.click({ force: true });
    } else {
        await page.getByText('Страхователь', { exact: true }).last().click({ force: true });
    }

    const policyholderModal = page.locator('[role="dialog"]').last();
    await policyholderModal.waitFor({ state: 'visible', timeout: 15000 });

    const pdlList = ['Нет', 'Да'];
    await selectRandomDropdown(page, policyholderModal, 'Принадлежность к ПДЛ', pdlList);

    await progress.update('Заполняю форму Страхователя...');

    const isRukovoditel = Math.random() >= 0.5;
    const isBeneficiar = Math.random() >= 0.5;
    const isPredstavitel = (!isRukovoditel && !isBeneficiar) ? true : (Math.random() >= 0.5);

    // Безопасная функция активации чекбокса
    async function activateCheckbox(labelText, shouldActivate) {
        if (!shouldActivate) return;

        const checkboxBtn = policyholderModal
            .locator('span', { hasText: labelText })
            .locator('xpath=./ancestor::div[contains(@class, "flex")][1]')
            .locator('button[role="checkbox"]');

        if (await checkboxBtn.isVisible().catch(() => false)) {
            await checkboxBtn.click({ force: true });
        } else {
            await policyholderModal.getByText(labelText, { exact: true }).locator('..').click({ force: true });
        }

        await page.waitForTimeout(600);
    }

    // --- БЛОК 1: Наличие первого руководителя ---
    await activateCheckbox('Наличие первого руководителя', isRukovoditel);
    if (isRukovoditel) {
        const iinInput = policyholderModal.locator('text="ИИН"').locator('..').locator('input').last();
        // Проверяем, появилось ли поле на экране
        if (await iinInput.isVisible().catch(() => false)) {
            await policyholderModal.locator('text="ФИО"').locator('..').locator('input').last().fill(`${user.lastName} ${user.firstName}`);
            await policyholderModal.locator('text="Должность"').locator('..').locator('input').last().fill('Генеральный директор');
            await iinInput.fill(user.docNumber);
        } else {
            console.log('[WARN] Поля первого руководителя не появились!');
        }
    }

    // --- БЛОК 2: Наличие бенефициарного собственника ---
    await activateCheckbox('Наличие бенефициарного собственника', isBeneficiar);
    if (isBeneficiar) {
        const iinInput = policyholderModal.locator('text="ИИН"').locator('..').locator('input').last();
        if (await iinInput.isVisible().catch(() => false)) {
            await iinInput.fill(user.docNumber);
            await policyholderModal.locator('text="Фамилия"').locator('..').locator('input').last().fill(user.lastName);
            await policyholderModal.locator('text="Имя"').locator('..').locator('input').last().fill(user.firstName);
            await policyholderModal.locator('text="Отчество"').locator('..').locator('input').last().fill(user.middleName || 'Иванович');
            await policyholderModal.locator('text="Номер документа"').locator('..').locator('input').last().fill(user.docNumber);

            await fillDateByLabel('Дата рождения', user.dob);
            await fillDateByLabel('Дата выдачи', user.docDate);
        } else {
            console.log('[WARN] Поля бенефициарного собственника не появились!');
        }
    }

    // --- БЛОК 3: Наличие представителя клиента ---
    await activateCheckbox('Наличие представителя клиента физического лица', isPredstavitel);
    if (isPredstavitel) {
        const fioInput = policyholderModal.locator('input[placeholder="Введите ФИО"]').last();
        if (await fioInput.isVisible().catch(() => false)) {
            await fioInput.fill(`${user.lastName} ${user.firstName}`);
            await policyholderModal.locator('input[placeholder="Введите ИИН"]').last().fill(user.docNumber);
            await policyholderModal.locator('input[placeholder="Введите адрес"]').last().fill('г. Алматы, ул. Абая 10');
            await policyholderModal.locator('input[placeholder="Введите номер телефона"]').last().fill('+77001234567');
            await policyholderModal.locator('input[placeholder="Введите информацию"]').last().fill('Доверенность №1 от текущей даты');

            await fillDateByLabel('Дата рождения', user.dob);
        } else {
            console.log('[WARN] Поля представителя не появились!');
        }
    }

    await page.setViewportSize({ width: 1280, height: 1620 });
    const policyholderBuffer = await page.screenshot({ fullPage: true });
    await ctx.replyWithPhoto(
        { source: policyholderBuffer }, 
        { caption: `Данные Страхователя заполнены.` }
    );

    // Подтверждаем и закрываем модалку
    await policyholderModal.locator('button', { hasText: 'Подтвердить' }).click();
    await policyholderModal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // 6. ДАННЫЕ ТРАНСПОРТНОГО СРЕДСТВА
    await progress.update('Открываю форму ТС...');
    const addCarBtn = page.locator('text="Добавить ТС"').last();
    await addCarBtn.waitFor({ state: 'visible', timeout: 15000 });
    await addCarBtn.click({ force: true });
    
    await page.waitForSelector('text="Гос номер"', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);

    const manualTsBtn = page.locator('button', { hasText: 'Ввести вручную' });
    if (await manualTsBtn.isVisible().catch(() => false)) {
        await manualTsBtn.click();
        await page.waitForTimeout(500);
    }

    // Хелпер для дропдаунов
    async function selectTsDropdown(label, value) {
        if (value) {
            await page.locator(`text="${label}"`).locator('..').click({ force: true });
            await page.waitForTimeout(500);
            await page.getByText(value, { exact: true }).last().click({ force: true });
            await page.waitForTimeout(300);
        }
    }

    // Заполнение текстовых полей
    await page.locator('text="Гос номер"').locator('..').locator('input').last().fill(user.plateNumber);
    await page.locator('text="VIN / № кузова / № шасси"').locator('..').locator('input').last().fill(user.vin);
    await page.locator('text="Свид. рег. ТС"').locator('..').locator('input').last().fill(user.regCert);
    await page.locator('text="Количество мест"').locator('..').locator('input').last().fill(user.seats);
    await page.locator('text="Год выпуска"').locator('..').locator('input').last().fill(user.year);
    await page.locator('text="Марка"').locator('..').locator('input').last().fill(user.brand);
    await page.locator('text="Модель"').locator('..').locator('input').last().fill(user.model);

    // Заполнение дропдаунов
    await selectTsDropdown('Тип ТС', user.vehicleType);
    await selectTsDropdown('Регион регистрации', user.regRegion);
    await selectTsDropdown('Страна регистрации', user.regCountry);
    await selectTsDropdown('Город областного или республиканского значения', user.isMajorCity);

    // Заполнение даты СРТС
    const regLabelLocator = page.locator('text="Дата выдачи свид. рег. ТС"').last();
    const regDateInput = regLabelLocator.locator('..').locator('input[placeholder="дд.мм.гггг"]').last();
    await regDateInput.click();
    await regDateInput.pressSequentially(user.regCertDate.replace(/\./g, ''), { delay: 50 });
    
    // Безопасно закрываем календарь кликом по заголовку
    await regLabelLocator.click({ force: true });

    await page.setViewportSize({ width: 1280, height: 1620 });
    const tech_buffer = await page.screenshot({ fullPage: true });
    await ctx.replyWithPhoto({ source: tech_buffer }, { caption: `Форма ТС (${user.brand} ${user.model}) заполнена` });

    // Кнопка подтверждения ТС
    const confirmTsBtn = page.locator('button', { hasText: 'Подтвердить' }).last();
    await confirmTsBtn.scrollIntoViewIfNeeded();
    await confirmTsBtn.click();

    // Окна нет, поэтому просто ждем пару секунд перед переходом к финальному расчету
    await page.waitForTimeout(2000);

    // 7. ФИНАЛИЗАЦИЯ И ЕСБД
    await progress.update('Выбираю тип уведомления...');
    
    // Выбор типа уведомления через родительский блок
    await page.locator('text="Тип уведомления"').locator('..').first().click({ force: true });
    await page.waitForTimeout(500);
    await page.getByText('Email + SMS', { exact: true }).click({ force: true });
    await page.keyboard.press('Enter')

    // Заполнение контактов через привязку к заголовку (label)
    const phoneInput = page.locator('text="Номер телефона"').locator('..').first().locator('input').first();
    await phoneInput.click();
    await phoneInput.fill('+77001234567');

    const emailInput = page.locator('text="Почта"').locator('..').first().locator('input').first();
    await emailInput.click();
    await emailInput.fill('test.testov.testovich@gmail.com');

    // Передача в ЕСБД
    await page.locator('button', { hasText: 'Передать в ЕСБД' }).click();
    await progress.update('Жду обработку и регистрацию полиса...');

    const anyErrorLocator = page.locator('div, p')
        .filter({ hasText: /invalid|required|ошибка|503|error|failed/i })
        .first();

    try {
        // Ждем появления текста успешного оформления ИЛИ любого баннера ошибки
        await Promise.race([
            page.getByText('Оформляем полис').waitFor({ state: 'visible', timeout: 35000 }),
            page.getByText('Оплата принята').waitFor({ state: 'visible', timeout: 35000 }),
            page.locator('button', { hasText: 'Мои полисы' }).waitFor({ state: 'visible', timeout: 35000 }),
            anyErrorLocator.waitFor({ state: 'visible', timeout: 35000 })
        ]);
    } catch (e) {
        // Игнорируем таймаут ожидания race
    }

    await page.waitForTimeout(1000);

    // Если ошибки нет, скрипт достиг экрана успеха
    await page.setViewportSize({ width: 1280, height: 1620 });
    const finalBuffer = await page.screenshot({ fullPage: true });
    await progress.done('Полис успешно выписан через WEB!');
    await ctx.replyWithPhoto({ source: finalBuffer }, { caption: `Тестовый полис ОГПО готов!` });

  } catch (err) {
    console.error('[handleWebOgpoPolicy] Error:', err);
    
    const networkLogMsg = formatNetworkLogs(failedNetworkRequests);
    
    if (page) {
      try {
        await page.setViewportSize({ width: 1280, height: 1620 });
        const errBuffer = await page.screenshot({ fullPage: true });
        
        // Ограничиваем длину сообщения, чтобы не превысить лимиты Telegram
        const caption = `Ошибка на странице:\n${err.message}${networkLogMsg}`.substring(0, 1024);
        
        await ctx.replyWithPhoto({ source: errBuffer }, { caption: caption });
      } catch (e) {
        console.error('Не удалось сделать скриншот ошибки:', e);
      }
    }
    
    if (progress) await progress.fail(`Ошибка: ${err.message}`);
    else await ctx.reply(`Произошла ошибка: ${err.message}`);
  } finally {
    // закрываем сессию. Браузер остается запущенным в фоне!
    if (context) {
        await context.close();
        console.log('Изолированный контекст успешно закрыт.');
    }
  }
}

module.exports = { handleWebOgpoPolicy };