'use strict';

/**
 * Подключает слушатель сети к странице Playwright и собирает ошибки 400+
 * @param {import('playwright').Page} page - Страница Playwright
 * @returns {Array} - Массив, в который будут собираться ошибки
 */
function setupNetworkLogger(page) {
    const failedRequests = [];

    page.on('response', async (response) => {
        const resourceType = response.request().resourceType();
        
        if (response.status() >= 400 && (resourceType === 'fetch' || resourceType === 'xhr')) {
            const request = response.request();
            let logEntry = `[${response.status()}] ${request.method()} ${response.url()}`;

            // 1. Логируем Payload (данные запроса)
            const payload = request.postData();
            if (payload) {
                // Обрезаем слишком длинные портянки, чтобы не спамить в Telegram
                const snippet = payload.length > 300 ? payload.substring(0, 300) + '...' : payload;
                logEntry += `\n   -> Payload: ${snippet}`;
            }

            // 2. Логируем ответ сервера (почему произошла ошибка)
            try {
                const responseBody = await response.text();
                if (responseBody) {
                    const resSnippet = responseBody.length > 300 ? responseBody.substring(0, 300) + '...' : responseBody;
                    logEntry += `\n   <- Response: ${resSnippet}`;
                }
            } catch (e) {
                // Игнорируем ошибки, если тело ответа прочитать невозможно (например, соединение сброшено)
                logEntry += `\n   <- Response: [Не удалось прочитать]`;
            }

            failedRequests.push(logEntry);
        }
    });

    return failedRequests;
}

/**
 * @param {Array} failedRequests - Массив с ошибками
 * @returns {String} - Готовый текст
 */

function formatNetworkLogs(failedRequests) {
    if (failedRequests.length > 0) {
        return '\n\nЛог вкладки Network:\n' + failedRequests.join('\n\n');
    }
    return '\n\nВкладка Network чиста (сетевых ошибок не зафиксировано).';
}

module.exports = { setupNetworkLogger, formatNetworkLogs };