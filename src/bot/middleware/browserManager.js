'use strict';

const { chromium } = require('playwright');

let globalBrowser = null;

// Инициализация глобального браузера при старте бота
async function initBrowser() {
    if (!globalBrowser) {
        console.log('🚀 Запуск глобального браузера Playwright...');
        globalBrowser = await chromium.launch({
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        console.log('✅ Глобальный браузер успешно запущен!');
    }
    return globalBrowser;
}

// Получение нового изолированного контекста (сессии)
async function getNewContext() {
    if (!globalBrowser) {
        await initBrowser(); // Подстраховка, если вдруг браузер упал
    }
    return await globalBrowser.newContext();
}

// Корректное закрытие браузера при остановке бота
async function closeBrowser() {
    if (globalBrowser) {
        await globalBrowser.close();
        globalBrowser = null;
        console.log('🛑 Глобальный браузер остановлен.');
    }
}

module.exports = { initBrowser, getNewContext, closeBrowser };