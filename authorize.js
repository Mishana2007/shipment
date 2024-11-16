const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const apiId = 27824147;
const apiHash = 'd534beb1bddc95249147e8b410c1e2b9';
let stringSession = new StringSession('');

async function startAuthorization() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    
    await client.start({
        phoneNumber: async () => {
            console.log('Введите ваш номер телефона в формате +1234567890:');
            return new Promise(resolve => process.stdin.once('data', data => resolve(data.toString().trim())));
        },
        password: async () => {
            console.log('Введите пароль:');
            return new Promise(resolve => process.stdin.once('data', data => resolve(data.toString().trim())));
        },
        phoneCode: async () => {
            console.log('Введите код из Telegram:');
            return new Promise(resolve => process.stdin.once('data', data => resolve(data.toString().trim())));
        },
        onError: (err) => console.log(`Ошибка: ${err.message}`),
    });

    console.log('Авторизация прошла успешно!');
    stringSession = client.session;
    fs.writeFileSync('session.json', stringSession.save(), 'utf8');
    console.log('Сессия сохранена в файл session.json');
}

startAuthorization();
