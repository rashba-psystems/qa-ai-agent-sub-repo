'use strict';

const lastNames = ['ШАРИПОВ', 'ИВАНОВ', 'СМАИЛОВ', 'КИМ', 'АХМЕТОВ', 'ПАК', 'САТПАЕВ', 'ДЖУМАЕВ', 'ЦОЙ', 'ИСАЕВ'];
const firstNames = ['АБДУЛЛА', 'ИВАН', 'АЛИШЕР', 'ДМИТРИЙ', 'АЙДАР', 'АЛЕКСАНДР', 'ТИМУР', 'МАКСИМ', 'АРСЕН', 'РУСЛАН'];
const middleNames = ['КАСИМОВИЧ', 'ИВАНОВИЧ', 'СЕРИКОВИЧ', 'ДМИТРИЕВИЧ', 'АМАНОВИЧ', 'АЛЕКСАНДРОВИЧ', 'ТИМУРОВИЧ', 'МАКСИМОВИЧ', '', ''];
const countries = ['Албания', 'Российская Федерация', 'Австрия', 'Германия', 'Кыргызстан', 'Узбекистан', 'Турция', 'Грузия'];
const brandsAndModels = [
    { brand: 'TOYOTA', model: 'CAMRY', type: 'Легковые', seats: '4' },
    { brand: 'HYUNDAI', model: 'ACCENT', type: 'Легковые', seats: '4' },
    { brand: 'MERCEDES-BENZ', model: 'ACTROS', type: 'Грузовые', seats: '2' },
    { brand: 'VOLKSWAGEN', model: 'POLO', type: 'Легковые', seats: '4' },
    { brand: 'KIA', model: 'RIO', type: 'Легковые', seats: '4' },
    { brand: 'YUTONG', model: 'ZK6122H9', type: 'Автобусы > 16 п.м.', seats: '50' },
    { brand: 'GAZ', model: 'GAZELLE', type: 'Автобусы до 16 п.м.', seats: '13' }
];

// Данные для заполнения юр лица
const legalNames = ['ТОО Альфа', 'АО ОмегаСтрой', 'ТОО АвтоТранс', 'ИП ТехПром', 'ТОО Глобал Логистик', 'ТОО Инновации', 'АО ЭнергоСбыт'];
const streets = ['Абая', 'Сатпаева', 'Толе би', 'Аль-Фараби', 'Достык', 'Сейфуллина', 'Райымбека', 'Калдаякова'];

// Хелперы для генерации случайных чисел и строк
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randStr = (length, chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') => 
    Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const randDate = (startYear, endYear) => 
    `${String(randInt(1, 28)).padStart(2, '0')}.${String(randInt(1, 12)).padStart(2, '0')}.${randInt(startYear, endYear)}`;


// ГЕНЕРАТОР 50 ПРОФИЛЕЙ
function generateUsers(count = 50) {
    const users = [];
    
    for (let i = 0; i < count; i++) {
        const car = brandsAndModels[randInt(0, brandsAndModels.length - 1)];
        const country = countries[randInt(0, countries.length - 1)];

        users.push({
            // --- ДАННЫЕ ЗАСТРАХОВАННОГО ---
            docType: 'Заграничный паспорт (иностранца)',
            docNumber: randStr(9, '0123456789'), 
            docDate: randDate(2020, 2026),
            isResident: 'Нет',
            citizenship: country,
            lastName: lastNames[randInt(0, lastNames.length - 1)],
            firstName: firstNames[randInt(0, firstNames.length - 1)],
            middleName: middleNames[randInt(0, middleNames.length - 1)],
            dob: randDate(1970, 2004),
            gender: Math.random() > 0.2 ? 'Мужской' : 'Женский', 
            benefits: 'Нет',
            driverLicenseType: 'Иностранные права',
            
            // --- ДАННЫЕ ТРАНСПОРТНОГО СРЕДСТВА (из формы ТС) ---
            plateNumber: `${randStr(1, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${randStr(3, '0123456789')}${randStr(2, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}`,
            vin: randStr(17), 
            regCert: randStr(8), 
            seats: car.seats,
            year: String(randInt(2005, 2024)),
            vehicleType: car.type,
            brand: car.brand,
            model: car.model,
            regCertDate: randDate(2020, 2026),
            regRegion: 'Временный въезд',
            regCountry: country,
            isMajorCity: 'Нет'
        });
    }

    // Захардкоженный профиль для стабильных тестов
    users[0] = {
        docType: 'Заграничный паспорт (иностранца)',
        docNumber: '905694675',
        docDate: '10.09.2026',
        isResident: 'Нет',
        citizenship: 'Албания',
        lastName: 'ШАРИПОВ',
        firstName: 'АБДУЛЛА',
        middleName: 'КАСИМОВИЧ',
        dob: '29.09.1999',
        gender: 'Мужской',
        benefits: 'Нет',
        driverLicenseType: 'Иностранные права',
        plateNumber: 'E3H545',
        vin: '45GREGEG567',
        regCert: '436H3P53',
        seats: '4',
        year: '2015',
        vehicleType: 'Легковые',
        brand: 'TOYOTA',
        model: 'CAMRY',
        regCertDate: '10.09.2026',
        regRegion: 'Временный въезд',
        regCountry: 'Австрия',
        isMajorCity: 'Нет'
    };

    return users;
}

const insuredUsers = generateUsers(50);

function getRandomUser() {
    const randomIndex = Math.floor(Math.random() * insuredUsers.length);
    return { ...insuredUsers[randomIndex] };
}

function getRandomLegalEntity() {
    return {
        companyName: legalNames[randInt(0, legalNames.length - 1)] + ' ' + randInt(1, 1000),
        address: 'г. Алматы, пр. ' + streets[randInt(0, streets.length - 1)] + ', ' + randInt(1, 200),
        sectorIndex: randInt(0, 8),
        okedPrefix: String(randInt(1, 99)).padStart(2, '0'),
        okedMoves: randInt(1, 5)
    };
}

function getFieldsToSkip(fieldsList) {
    const numToSkip = Math.floor(Math.random() * 3); 
    const skippedFields = [];
    const tempFields = [...fieldsList];
    
    for (let i = 0; i < numToSkip; i++) {
        const randIdx = Math.floor(Math.random() * tempFields.length);
        skippedFields.push(tempFields.splice(randIdx, 1)[0]);
    }
    return skippedFields;
}

async function selectRandomDropdown(page, container, label, fallbackOptions = []) {
    await container.locator(`text="${label}"`).locator('..').click({ force: true });
    await page.waitForTimeout(500);

    const optionsLocator = page.getByRole('option'); 
    await optionsLocator.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    
    const count = await optionsLocator.count();
    
    if (count > 0) {
        const randomIndex = Math.floor(Math.random() * count);
        await optionsLocator.nth(randomIndex).click({ force: true });
    } else if (fallbackOptions && fallbackOptions.length > 0) {
        const randomText = fallbackOptions[Math.floor(Math.random() * fallbackOptions.length)];
        console.log(`[INFO] Использую резервный список для "${label}": ${randomText}`);
        
        await page.getByText(randomText, { exact: true }).last().click({ force: true });
    } else {
        console.log(`[WARN] Опции для "${label}" не найдены, список оставлен по умолчанию.`);
        await container.locator(`text="${label}"`).locator('..').click({ force: true }); 
    }
    
    await page.waitForTimeout(300);
}

module.exports = { getRandomUser, getFieldsToSkip, insuredUsers, getRandomLegalEntity, selectRandomDropdown };