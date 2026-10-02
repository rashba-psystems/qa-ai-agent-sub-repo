'use strict';

const { Progress } = require('../progress');
const { getNewContext } = require('../middleware/browserManager');
const { getRandomUser, getRandomLegalEntity } = require('../testDataProvider');
const { setupNetworkLogger, formatNetworkLogs } = require('../middleware/logger');


async function handleWebOgpoLegal(ctx) {
    let progress = null;
    let context = null;
    let page = null;
    let failedNetworkRequests = [];

    try {
        progress = await new Progress(ctx, 'Создаю изолированную сессию (Юр. Лицо)...').start();
        
        context = await getNewContext();
        page = await context.newPage();
        failedNetworkRequests = setupNetworkLogger(page);

        // 1 & 2. АВТОРИЗАЦИЯ И ОТКРЫТИЕ ФОРМЫ
        await progress.update('Прохожу авторизацию...');
        await page.goto('https://dev.myndp.kz/authorization'); 
        await page.click('text=Пароль');
        await page.waitForSelector('input[placeholder="Введите свой логин"]', { state: 'visible' });
        await page.fill('input[placeholder="Введите свой логин"]', process.env.MYNDP_LOGIN);
        await page.fill('input[placeholder="*****"]', process.env.MYNDP_PASSWORD);
        await page.click('button:has-text("Войти")');
        await page.waitForURL('**/dashboard**', { timeout: 15000 }); 

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

        // 3. ДАННЫЕ ЗАСТРАХОВАННОГО
        await progress.update('Заполняю данные юридического лица...');
        
        const insuredModal = page.locator('[role="dialog"]').last();
        await insuredModal.getByText('Юр. лицо', { exact: true }).click({ force: true });
        await page.waitForTimeout(1000);

        const manualBtn = insuredModal.locator('button', { hasText: 'Ввести вручную' });
        if (await manualBtn.isVisible().catch(() => false)) {
            await manualBtn.click();
            await page.waitForTimeout(500);
        }

        // Получаем случайные данные из провайдера
        const legalData = getRandomLegalEntity();
        const user = getRandomUser(); // Берем профиль физлица для ТС и страны

        // Ввод текста (Название и Адрес)
        await insuredModal.locator('input[placeholder="Введите название юр. лица"]').fill(legalData.companyName);
        await insuredModal.locator('input[placeholder="Введите адрес"]').fill(legalData.address);
        await page.waitForTimeout(300);

        // Гражданство (Берем из случайного пользователя)
        await insuredModal.locator('text="Выберите гражданство"').first().click({ force: true });
        await page.waitForTimeout(500);
        await page.getByText(user.citizenship, { exact: true }).last().click({ force: true });
        await page.waitForTimeout(300);

        // Сектор экономики (Умная навигация на основе randomSectorIndex)
        await insuredModal.locator('text="Сектор экономики"').locator('..').click({ force: true });
        await page.waitForTimeout(500);
        
        // Жесткий список всех 9 секторов
        const sectors = [
            '1 — Центральное Правительство',
            '2 — Региональные и местные органы управления',
            '3 — Центральные (национальные) банки',
            '4 — Другие депозитные организации',
            '5 — Другие финансовые организации',
            '6 — Государственные нефинансовые организации',
            '7 — Негосударственные нефинансовые организации',
            '8 — Некоммерческие организации, обслуживающие домашние хозяйства',
            '9 — Домашние хозяйства (физические лица)'
        ];
        const randomSector = sectors[Math.floor(Math.random() * sectors.length)];
        
        // Клик по точному совпадению гарантированно закроет меню
        await page.getByText(randomSector, { exact: true }).last().click({ force: true });
        await page.waitForTimeout(300);

        // ОКЭД (Фильтрация и навигация)
        await insuredModal.locator('text="ОКЭД (вид деятельности)"').locator('..').click({ force: true });
        await page.waitForTimeout(500);
        
        // Жесткий список проверенных 5-значных кодов ОКЭД
        const okeds = [
            '01111', // Выращивание зерновых
            '01112', // Выращивание масличных
            '01120', // Выращивание риса
            '08930', // Добыча соли
            '25940', // Производство крепежных изделий
            '49100', // Пассажирский ЖД транспорт
            '49200', // Грузовой ЖД транспорт
            '84210'  // Международная деятельность
        ];
        const randomOkedCode = okeds[Math.floor(Math.random() * okeds.length)];
        
        // Печатаем цифры системной клавиатурой (фокус уже на меню, поле поиска найдет их само)
        await page.keyboard.type(randomOkedCode, { delay: 100 });
        await page.waitForTimeout(1000); // Ждем долю секунды, чтобы список обновился
        
        // Кликаем по элементу, который содержит введенный код (гарантированно закроет меню)
        await page.getByText(randomOkedCode).first().click({ force: true });
        await page.waitForTimeout(500);

        await page.setViewportSize({ width: 1280, height: 2000 });
        const insuredBuffer = await page.screenshot({ fullPage: true });
        await ctx.replyWithPhoto({ source: insuredBuffer }, { caption: `Юр. лицо "${legalData.companyName}" заполнено.` });

        const confirmInsuredBtn = insuredModal.locator('button', { hasText: 'Подтвердить' }).last();
        await confirmInsuredBtn.scrollIntoViewIfNeeded();
        await confirmInsuredBtn.click({ force: true });
        await insuredModal.waitFor({ state: 'hidden', timeout: 15000 });
        await page.waitForTimeout(1000);

        // 4. ДАННЫЕ ТРАНСПОРТНОГО СРЕДСТВА
        await progress.update('Заполняю данные ТС...');

        const addCarBtn = page.locator('text="Добавить ТС"').last();
        await addCarBtn.waitFor({ state: 'visible', timeout: 15000 });
        await addCarBtn.click({ force: true });
        
        await page.waitForSelector('text="Гос номер"', { state: 'visible', timeout: 15000 });

        const tsModal = page.locator('[role="dialog"]').first();
        const manualTsBtn = tsModal.locator('button', { hasText: 'Ввести вручную' });
        if (await manualTsBtn.isVisible().catch(() => false)) {
            await manualTsBtn.click();
            await page.waitForTimeout(500);
        }

        async function selectTsDropdown(label, value) {
            if (value) {
                await tsModal.locator(`text="${label}"`).locator('..').click({ force: true });
                await page.waitForTimeout(500);
                await page.getByText(value, { exact: true }).last().click({ force: true });
                await page.waitForTimeout(300);
            }
        }

        await tsModal.locator('text="Гос номер"').locator('..').locator('input').first().fill(user.plateNumber);
        await tsModal.locator('text="VIN / № кузова / № шасси"').locator('..').locator('input').first().fill(user.vin);
        await tsModal.locator('text="Свид. рег. ТС"').locator('..').locator('input').first().fill(user.regCert);
        await tsModal.locator('text="Количество мест"').locator('..').locator('input').first().fill(user.seats);
        await tsModal.locator('text="Год выпуска"').locator('..').locator('input').first().fill(user.year);
        await tsModal.locator('text="Марка"').locator('..').locator('input').first().fill(user.brand);
        await tsModal.locator('text="Модель"').locator('..').locator('input').first().fill(user.model);

        await selectTsDropdown('Тип ТС', user.vehicleType);
        await selectTsDropdown('Регион регистрации', user.regRegion);
        await selectTsDropdown('Страна регистрации', user.regCountry);
        await selectTsDropdown('Город областного или республиканского значения', user.isMajorCity);

        const regDateInput = tsModal.locator('text="Дата выдачи свид. рег. ТС"').locator('..').locator('input[placeholder="дд.мм.гггг"]').first();
        await regDateInput.click();
        await regDateInput.pressSequentially(user.regCertDate.replace(/\./g, ''), { delay: 50 });
        await regDateInput.press('Escape');

        await page.setViewportSize({ width: 1280, height: 2000 });
        const techBuffer = await page.screenshot({ fullPage: true });
        await ctx.replyWithPhoto({ source: techBuffer }, { caption: `Форма ТС (${user.brand} ${user.model}) заполнена` });

        const confirmTsBtn = tsModal.locator('button', { hasText: 'Подтвердить' }).last();
        await confirmTsBtn.scrollIntoViewIfNeeded();
        await confirmTsBtn.click();
        await tsModal.waitFor({ state: 'hidden', timeout: 15000 });
        await page.waitForTimeout(3000);

        // 5. ФИНАЛИЗАЦИЯ И ЕСБД
        await progress.update('Выбираю тип уведомления...');
        
        await page.locator('text="Тип уведомления"').locator('..').first().click({ force: true });
        await page.waitForTimeout(500);
        await page.getByText('Email + SMS', { exact: true }).last().click({ force: true });
        
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const phoneInput = page.locator('text="Номер телефона"').locator('..').first().locator('input').first();
        await phoneInput.fill('+77001234567', { force: true });

        const emailInput = page.locator('text="Почта"').locator('..').first().locator('input').first();
        await emailInput.fill('test.legal@gmail.com', { force: true });

        await page.locator('button', { hasText: 'Передать в ЕСБД' }).click();
        await progress.update('Жду обработку и регистрацию полиса...');

        try {
            await Promise.race([
                page.getByText('Оформляем полис').waitFor({ state: 'visible', timeout: 35000 }),
                page.getByText('Оплата принята').waitFor({ state: 'visible', timeout: 35000 }),
                page.locator('button', { hasText: 'Мои полисы' }).waitFor({ state: 'visible', timeout: 35000 }),
                page.getByText(/503: Service Unavailable|Ошибка ЕСБД|Внутренняя ошибка/i).waitFor({ state: 'visible', timeout: 35000 })
            ]);
        } catch (e) {}

        const esbdErrorBanner = page.getByText(/503: Service Unavailable|Ошибка ЕСБД/i);
        if (await esbdErrorBanner.isVisible().catch(() => false)) {
            await page.setViewportSize({ width: 1280, height: 2000 });
            const errBuffer = await page.screenshot({ fullPage: true });
            await progress.fail('Ошибка ЕСБД при расчете!');
            await ctx.replyWithPhoto({ source: errBuffer }, { caption: 'Оформление прервано сервером ЕСБД (Ошибка интеграции).' });
            return; 
        }

        await page.setViewportSize({ width: 1280, height: 2000 });
        const finalBuffer = await page.screenshot({ fullPage: true });
        await progress.done('Полис успешно выписан через WEB!');
        await ctx.replyWithPhoto({ source: finalBuffer }, { caption: `Тестовый полис ОГПО (Юр. лицо) готов!` });

    } catch (err) {
        console.error('[handleWebOgpoLegal] Error:', err);
        const networkLogMsg = formatNetworkLogs(failedNetworkRequests);
        
        if (page) {
            try {
                await page.setViewportSize({ width: 1280, height: 2000 });
                const errBuffer = await page.screenshot({ fullPage: true });
                const caption = `Ошибка на странице:\n${err.message}${networkLogMsg}`.substring(0, 1024);
                await ctx.replyWithPhoto({ source: errBuffer }, { caption: caption });
            } catch (e) {}
        }
        
        if (progress) await progress.fail(`Ошибка: ${err.message}`);
        else await ctx.reply(`Произошла ошибка: ${err.message}`);
    } finally {
        if (context) await context.close();
    }
}

module.exports = { handleWebOgpoLegal };