const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { NewMessage } = require('telegram/events');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Конфигурация
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    API_ID: parseInt(process.env.API_ID),
    API_HASH: process.env.API_HASH,
    DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT) || 300000,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 60000,
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 60000
};

// Функция задержки
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Инициализация базы данных
const db = new sqlite3.Database('bot_data.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
        process.exit(1);
    }
    console.log('Подключено к базе данных SQLite');
    initDatabase();
});

// Инициализация таблиц базы данных
function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            chat_id TEXT UNIQUE,
            username TEXT,
            first_seen TEXT,
            last_active TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY,
            channel_id TEXT,
            channel_name TEXT,
            channel_link TEXT UNIQUE,
            last_post_id TEXT,
            added_by TEXT,
            added_date TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS request_history (
            id INTEGER PRIMARY KEY,
            chat_id TEXT,
            channel_link TEXT,
            request_date TEXT,
            success INTEGER,
            error_message TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS user_subscriptions (
            id INTEGER PRIMARY KEY,
            user_id TEXT,
            channel_id TEXT,
            last_post_id TEXT,
            added_date TEXT,
            UNIQUE(user_id, channel_id)
        )`);
    });
}

// Загрузка сессии
let stringSession;
try {
    if (fs.existsSync('session.json')) {
        const savedSession = fs.readFileSync('session.json', 'utf8');
        stringSession = new StringSession(savedSession);
    } else {
        stringSession = new StringSession('');
    }
} catch (error) {
    console.error('Ошибка при загрузке сессии:', error);
    stringSession = new StringSession('');
}

// Инициализация Telegram клиента
const client = new TelegramClient(stringSession, CONFIG.API_ID, CONFIG.API_HASH, { 
    connectionRetries: 5,
    useWSS: true,
    timeout: CONFIG.DOWNLOAD_TIMEOUT,
    downloadRetries: 5,
    connectionTimeout: CONFIG.DOWNLOAD_TIMEOUT,
    maxConcurrentDownloads: 2,
    floodSleepThreshold: 60
});

// Инициализация бота
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// Функции базы данных
async function saveUser(msg) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        const user = msg.from;
        
        if (!user) {
            reject(new Error('Не удалось получить информацию о пользователе'));
            return;
        }

        const { id, username, first_name } = user;
        
        db.run(`
            INSERT OR REPLACE INTO users (chat_id, username, first_seen, last_active)
            VALUES (?, ?, COALESCE((SELECT first_seen FROM users WHERE chat_id = ?), ?), ?)
        `, [id.toString(), username || first_name, id.toString(), now, now], function(err) {
            if (err) {
                console.error('Ошибка при сохранении пользователя:', err);
                reject(err);
            } else {
                resolve(this.lastID);
            }
        });
    });
}

async function saveChannel(entity, link, addedBy) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(`
            INSERT OR REPLACE INTO channels (channel_id, channel_name, channel_link, added_by, added_date)
            VALUES (?, ?, ?, ?, ?)
        `, [entity.id.toString(), entity.title || entity.username, link, addedBy.toString(), now], function(err) {
            if (err) {
                console.error('Ошибка при сохранении канала:', err);
                reject(err);
            } else {
                resolve(this.lastID);
            }
        });
    });
}

async function getChannelByLink(link) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM channels WHERE channel_link = ?', [link], (err, row) => {
            if (err) {
                console.error('Ошибка при получении канала:', err);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function addSubscription(userId, channelId, lastPostId) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(`
            INSERT OR REPLACE INTO user_subscriptions (user_id, channel_id, last_post_id, added_date)
            VALUES (?, ?, ?, ?)
        `, [userId.toString(), channelId.toString(), lastPostId || '0', now], function(err) {
            if (err) {
                console.error('Ошибка при добавлении подписки:', err);
                reject(err);
            } else {
                resolve(this.lastID);
            }
        });
    });
}

async function getUserSubscriptions(userId) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT us.*, c.channel_name, c.channel_link
            FROM user_subscriptions us
            JOIN channels c ON us.channel_id = c.channel_id
            WHERE us.user_id = ?
        `, [userId.toString()], (err, rows) => {
            if (err) {
                console.error('Ошибка при получении подписок:', err);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

async function deleteSubscription(userId, channelId) {
    return new Promise((resolve, reject) => {
        db.run(`
            DELETE FROM user_subscriptions
            WHERE user_id = ? AND channel_id = ?
        `, [userId.toString(), channelId.toString()], function(err) {
            if (err) {
                console.error('Ошибка при удалении подписки:', err);
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

async function updateLastPostId(userId, channelId, postId) {
    return new Promise((resolve, reject) => {
        db.run(`
            UPDATE user_subscriptions
            SET last_post_id = ?
            WHERE user_id = ? AND channel_id = ?
        `, [postId, userId.toString(), channelId.toString()], function(err) {
            if (err) {
                console.error('Ошибка при обновлении ID последнего поста:', err);
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

// Функции для работы с медиа
function getMediaType(media) {
    if (!media) return null;
    
    try {
        if (media.photo || (media._ && media._ === 'MessageMediaPhoto')) {
            return 'photo';
        }
        
        if (media.document || (media._ && media._ === 'MessageMediaDocument')) {
            const document = media.document || media;
            const attributes = document.attributes || [];
            const mimeType = document.mime_type || '';
            
            const isVideo = attributes.some(attr => 
                attr._ === 'DocumentAttributeVideo' || 
                (mimeType && mimeType.startsWith('video'))
            );
            if (isVideo) return 'video';
            
            const isAnimation = attributes.some(attr => 
                attr._ === 'DocumentAttributeAnimated' || 
                mimeType === 'image/gif'
            );
            if (isAnimation) return 'animation';
            
            return 'document';
        }

        return null;
    } catch (error) {
        console.error('Ошибка при определении типа медиа:', error);
        return null;
    }
}

async function downloadMedia(media, retries = 3) {
    if (!media) return null;

    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const buffer = await client.downloadMedia(media, {
                timeout: CONFIG.DOWNLOAD_TIMEOUT
            });
            return buffer;
        } catch (error) {
            console.error(`Попытка ${i + 1}/${retries} загрузки медиа не удалась:`, error.message);
            lastError = error;
            if (i < retries - 1) {
                await delay(CONFIG.RETRY_DELAY);
            }
        }
    }
    
    throw new Error(`Не удалось загрузить медиафайл после ${retries} попыток: ${lastError.message}`);
}

async function sendMediaMessage(chatId, buffer, mediaType, caption) {
    try {
        const options = {
            caption,
            parse_mode: 'Markdown',
            disable_notification: false
        };

        switch (mediaType) {
            case 'photo':
                await bot.sendPhoto(chatId, buffer, options);
                break;
            case 'video':
                await bot.sendVideo(chatId, buffer, {
                    ...options,
                    supports_streaming: true
                });
                break;
            case 'animation':
                await bot.sendAnimation(chatId, buffer, options);
                break;
            case 'document':
                await bot.sendDocument(chatId, buffer, options);
                break;
            default:
                throw new Error(`Неподдерживаемый тип медиа: ${mediaType}`);
        }
    } catch (error) {
        console.error('Ошибка при отправке медиа:', error);
        throw error;
    }
}

// Функция обработки нового поста
async function handleNewPost(post, channel, subscribers) {
    try {
        const caption = `*Новый пост из канала ${channel.channel_name}*\n\n${post.message || ''}`;

        for (const subscriber of subscribers) {
            try {
                if (post.media) {
                    if (Array.isArray(post.media)) {
                        const mediaGroup = [];
                        for (const mediaItem of post.media) {
                            try {
                                const type = getMediaType(mediaItem);
                                if (type) {
                                    const buffer = await downloadMedia(mediaItem);
                                    if (buffer) {
                                        mediaGroup.push({
                                            type,
                                            media: buffer,
                                            caption: mediaGroup.length === 0 ? caption : undefined,
                                            parse_mode: 'Markdown'
                                        });
                                    }
                                }
                                await delay(1000);
                            } catch (error) {
                                console.error('Ошибка при обработке медиафайла:', error);
                            }
                        }

                        if (mediaGroup.length > 0) {
                            await bot.sendMediaGroup(subscriber.user_id, mediaGroup);
                        } else {
                            await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                        }
                    } else {
                        const type = getMediaType(post.media);
                        if (type) {
                            const buffer = await downloadMedia(post.media);
                            if (buffer) {
                                await sendMediaMessage(subscriber.user_id, buffer, type, caption);
                            } else {
                                await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                            }
                        }
                    }
                } else {
                    await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                }

                await updateLastPostId(subscriber.user_id, channel.channel_id, post.id.toString());
            } catch (error) {
                console.error(`Ошибка при отправке поста пользователю ${subscriber.user_id}:`, error);
            }
        }
    } catch (error) {
        console.error('Ошибка при обработке нового поста:', error);
    }
}

// Функция для получения информации о канале
async function resolveEntity(link) {
    try {
        let entity;
        if (link.startsWith('@')) {
            entity = await client.getEntity(link);
        } else if (link.includes('joinchat')) {
            const hash = link.split('/').pop();
            entity = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
            if (entity.chat) {
                entity = entity.chat;
            }
        } else {
            const username = link.split('/').pop();
            entity = await client.getEntity(username);
        }
        return entity;
    } catch (error) {
        throw new Error(`Не удалось получить информацию о канале: ${error.message}`);
    }
}

// Функция мониторинга каналов
async function setupChannelMonitoring() {
    try {
        const channels = await new Promise((resolve, reject) => {
            db.all(`
                SELECT DISTINCT c.*
                FROM channels c
                JOIN user_subscriptions us ON c.channel_id = us.channel_id
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Удаляем все предыдущие обработчики
        client.removeEventHandler();

        // Создаем один общий обработчик для всех каналов
        client.addEventHandler(async (update) => {
            try {
                if (!update.message || !update.message.peerId) return;

                const channelId = update.message.peerId.channelId?.toString();
                if (!channelId) return;

                // Находим канал в нашем списке
                const channel = channels.find(c => c.channel_id === channelId);
                if (!channel) return;

                // Получаем подписчиков канала
                const subscribers = await new Promise((resolve, reject) => {
                    db.all(`
                        SELECT user_id, last_post_id
                        FROM user_subscriptions
                        WHERE channel_id = ?
                    `, [channelId], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    });
                });

                if (subscribers.length > 0) {
                    await handleNewPost(update.message, channel, subscribers);
                }
            } catch (error) {
                console.error('Ошибка в обработчике событий:', error);
            }
        }, new NewMessage({}));

        console.log(`Мониторинг настроен для ${channels.length} каналов`);
    } catch (error) {
        console.error('Ошибка при настройке мониторинга каналов:', error);
    }
}

// Улучшенная функция обработки нового поста
async function handleNewPost(message, channel, subscribers) {
    try {
        if (!message || !channel || !subscribers.length) return;

        const messageId = message.id?.toString();
        if (!messageId) return;

        const caption = `*Новый пост из канала ${channel.channel_name}*\n\n${message.message || ''}`;

        for (const subscriber of subscribers) {
            try {
                if (messageId <= (subscriber.last_post_id || '0')) continue;

                if (message.media) {
                    if (Array.isArray(message.media)) {
                        const mediaGroup = [];
                        for (const mediaItem of message.media) {
                            try {
                                const type = getMediaType(mediaItem);
                                if (type) {
                                    const buffer = await downloadMedia(mediaItem);
                                    if (buffer) {
                                        mediaGroup.push({
                                            type,
                                            media: buffer,
                                            caption: mediaGroup.length === 0 ? caption : undefined,
                                            parse_mode: 'Markdown'
                                        });
                                    }
                                }
                                await delay(1000);
                            } catch (error) {
                                console.error('Ошибка при обработке медиафайла:', error);
                            }
                        }

                        if (mediaGroup.length > 0) {
                            await bot.sendMediaGroup(subscriber.user_id, mediaGroup);
                        } else {
                            await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                        }
                    } else {
                        const type = getMediaType(message.media);
                        if (type) {
                            const buffer = await downloadMedia(message.media);
                            if (buffer) {
                                await sendMediaMessage(subscriber.user_id, buffer, type, caption);
                            } else {
                                await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                            }
                        }
                    }
                } else {
                    await bot.sendMessage(subscriber.user_id, caption, { parse_mode: 'Markdown' });
                }

                await updateLastPostId(subscriber.user_id, channel.channel_id, messageId);
            } catch (error) {
                console.error(`Ошибка при отправке поста пользователю ${subscriber.user_id}:`, error);
            }
        }
    } catch (error) {
        console.error('Ошибка при обработке нового поста:', error);
    }
}

// Обработчики команд бота
bot.onText(/\/start/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        await saveUser(msg);
        
        const helpMessage = `
Привет! Я бот для получения последних постов из Telegram каналов. 

Как использовать:
1. Отправьте мне ссылку на канал в формате:
   - @channel_name
   - https://t.me/channel_name
   - https://t.me/joinchat/...

2. Я автоматически:
   - Подключусь к каналу
   - Буду отслеживать новые посты
   - Отправлять их вам в реальном времени

📌 У вас может быть максимум 10 подписок на каналы!

Доступные команды:
/start - Показать это сообщение
/list - Показать список ваших подписок
/delete - Удалить подписку на канал
        `;
        
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Ошибка при обработке команды /start:', error);
        await bot.sendMessage(msg.chat.id, 'Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const subscriptions = await getUserSubscriptions(chatId);
        if (subscriptions.length === 0) {
            return bot.sendMessage(chatId, 'У вас пока нет подписок на каналы.');
        }

        let message = '*Ваши подписки на каналы:*\n\n';
        subscriptions.forEach((sub, index) => {
            message += `${index + 1}. ${sub.channel_name}\n`;
            message += `🔗 Ссылка: ${sub.channel_link}\n`;
            message += `📅 Добавлен: ${new Date(sub.added_date).toLocaleString()}\n\n`;
        });

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Ошибка при получении списка подписок:', error);
        await bot.sendMessage(chatId, 'Произошла ошибка при получении списка подписок.');
    }
});

bot.onText(/\/delete/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const subscriptions = await getUserSubscriptions(chatId);
        if (subscriptions.length === 0) {
            return bot.sendMessage(chatId, 'У вас нет активных подписок для удаления.');
        }

        let message = '*Выберите канал для удаления:*\n\n';
        subscriptions.forEach((sub, index) => {
            message += `/${index + 1} - ${sub.channel_name}\n`;
        });

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Ошибка при получении списка для удаления:', error);
        await bot.sendMessage(chatId, 'Произошла ошибка при получении списка каналов.');
    }
});

bot.onText(/\/(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const index = parseInt(match[1]) - 1;

    try {
        const subscriptions = await getUserSubscriptions(chatId);
        if (index < 0 || index >= subscriptions.length) {
            return bot.sendMessage(chatId, 'Неверный номер канала.');
        }

        const subscription = subscriptions[index];
        await deleteSubscription(chatId, subscription.channel_id);
        await bot.sendMessage(
            chatId, 
            `✅ Подписка на канал ${subscription.channel_name} удалена.`
        );
    } catch (error) {
        console.error('Ошибка при удалении подписки:', error);
        await bot.sendMessage(chatId, 'Произошла ошибка при удалении подписки.');
    }
});

// Функция извлечения ссылок
function extractLinks(text) {
    if (!text) return [];
    
    const regex = /@[\w\d_]+|https:\/\/t\.me\/(?:joinchat\/)?[\w\d_-]+/g;
    const matches = text.match(regex) || [];
    return matches.filter(link => {
        return link.startsWith('@') || 
               link.startsWith('https://t.me/joinchat/') ||
               link.startsWith('https://t.me/');
    });
}

// Основной обработчик сообщений
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        
        // Пропускаем команды
        if (!msg.text || msg.text.startsWith('/')) return;

        const links = extractLinks(msg.text);
        if (links.length === 0) {
            return bot.sendMessage(chatId, 'Пожалуйста, отправьте корректную ссылку на канал.');
        }

        // Проверяем лимит подписок
        const subscriptions = await getUserSubscriptions(chatId);
        if (subscriptions.length >= 10) {
            return bot.sendMessage(chatId, 'У вас уже достигнут лимит в 10 каналов. Удалите некоторые каналы перед добавлением новых.');
        }

        await bot.sendMessage(chatId, '🔄 Подключаюсь к каналу...');

        for (const link of links) {
            try {
                const existingChannel = await getChannelByLink(link);
                let entity;

                if (existingChannel) {
                    entity = await client.getEntity(existingChannel.channel_id);
                } else {
                    entity = await resolveEntity(link);
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
                    await saveChannel(entity, link, chatId);
                }

                await addSubscription(chatId, entity.id.toString(), '0');
                await bot.sendMessage(
                    chatId, 
                    `✅ Вы успешно подписались на канал ${entity.title || entity.username}\n\nТеперь вы будете получать новые посты из этого канала в реальном времени.`
                );

                await setupChannelMonitoring();

            } catch (error) {
                console.error(`Ошибка при обработке ${link}:`, error);
                await bot.sendMessage(chatId, `❌ Ошибка при подписке на ${link}:\n${error.message}`);
            }
        }
    } catch (error) {
        console.error('Ошибка при обработке сообщения:', error);
        if (msg?.chat?.id) {
            await bot.sendMessage(msg.chat.id, 'Произошла ошибка при обработке вашего сообщения. Попробуйте позже.');
        }
    }
});

// Запуск бота
(async () => {
    try {
        await client.connect();
        console.log('Telegram клиент подключен');
        fs.writeFileSync('session.json', client.session.save());
        
        // Запускаем мониторинг каналов
        await setupChannelMonitoring();
        console.log('Мониторинг каналов запущен');
        
        console.log('Бот успешно запущен!');
    } catch (error) {
        console.error('Ошибка при запуске бота:', error);
        process.exit(1);
    }
})();

// Обработка ошибок
process.on('unhandledRejection', (error) => {
    console.error('Необработанная ошибка:', error);
});

// Обработка завершения работы
process.on('SIGINT', async () => {
    console.log('Завершение работы...');
    try {
        await client.disconnect();
        await new Promise((resolve, reject) => {
            db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        console.log('База данных закрыта.');
        process.exit(0);
    } catch (error) {
        console.error('Ошибка при завершении работы:', error);
        process.exit(1);
    }
});