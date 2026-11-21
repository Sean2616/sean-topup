import crypto from 'crypto';

// =========================================================================
// Bot Telegram Sean Top Up (Vercel Serverless Webhook)
// -------------------------------------------------------------------------
// Environment Variables di Vercel:
//   TELEGRAM_BOT_TOKEN  = Token bot dari @BotFather
//   TELEGRAM_CHAT_ID    = Chat ID Admin (bisa lebih dari 1, pisahkan koma)
//   DIGIFLAZZ_USERNAME  = Username Digiflazz
//   DIGIFLAZZ_API_KEY   = Production API Key Digiflazz
//   FIREBASE_DB_URL     = URL Firebase Realtime Database
//   FIREBASE_DB_SECRET  = Database Secret Firebase (opsional)
//
// Cara aktifkan webhook (buka sekali di browser setelah deploy):
//   GET https://topup.disean.my.id/api/telegram?setup=1&secret=WEBHOOK_SECRET
// =========================================================================

function formatRp(num) {
    return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

function escTg(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getAllowedChatIds() {
    const raw = process.env.TELEGRAM_CHAT_ID || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function firebaseUrl(path) {
    const base = process.env.FIREBASE_DB_URL
        ? process.env.FIREBASE_DB_URL.replace(/\/$/, '')
        : null;
    if (!base) return null;
    const secret = process.env.FIREBASE_DB_SECRET;
    return secret
        ? `${base}${path}.json?auth=${encodeURIComponent(secret)}`
        : `${base}${path}.json`;
}

async function sendTelegram(chatId, htmlText) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !chatId) return { ok: false, error: 'TELEGRAM_BOT_TOKEN / chatId belum diatur' };
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: htmlText,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        return await r.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function fetchDigiflazzBalance() {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;
    if (!username || !apiKey) return { ok: false, message: 'DIGIFLAZZ_USERNAME / DIGIFLAZZ_API_KEY belum dipasang di Vercel.' };

    const sign = crypto.createHash('md5').update(`${username}${apiKey}depo`).digest('hex');
    const r = await fetch('https://api.digiflazz.com/v1/cek-saldo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'deposit', username, sign })
    });
    const j = await r.json();
    if (j && j.data && typeof j.data.deposit === 'number') {
        return { ok: true, deposit: j.data.deposit };
    }
    return { ok: false, message: (j && j.data && j.data.message) || 'Gagal mengambil saldo dari Digiflazz.' };
}

async function fetchDigiflazzCatalog() {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;
    if (!username || !apiKey) return { ok: false, message: 'DIGIFLAZZ_USERNAME / DIGIFLAZZ_API_KEY belum dipasang di Vercel.' };

    const sign = crypto.createHash('md5').update(`${username}${apiKey}pricelist`).digest('hex');
    const r = await fetch('https://api.digiflazz.com/v1/price-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'prepaid', username, sign })
    });
    const j = await r.json();
    if (j && Array.isArray(j.data)) {
        return { ok: true, list: j.data };
    }
    return { ok: false, message: (j && j.data && j.data.message) || 'Digiflazz menolak permintaan pricelist.' };
}

async function fetchFirebaseJson(path) {
    const url = firebaseUrl(path);
    if (!url) return null;
    try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

async function processDigiflazzOrder(order) {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;
    if (!username || !apiKey) {
        return { success: false, status: 'ERROR', message: 'API Key Digiflazz belum dipasang di Vercel' };
    }
    const sign = crypto.createHash('md5').update(`${username}${apiKey}${order.invoiceId}`).digest('hex');
    const r = await fetch('https://api.digiflazz.com/v1/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username,
            buyer_sku_code: order.sku,
            customer_no: order.customerNo || `${order.userId}${order.zoneId}`,
            ref_id: order.invoiceId,
            sign
        })
    });
    const payload = await r.json();
    const data = (payload && payload.data) || {};
    const status = data.status || 'ERROR';
    const accepted = status === 'Sukses' || status === 'Pending';
    return {
        success: accepted,
        status,
        message: data.message || 'Digiflazz tidak memberi keterangan.',
        rc: data.rc || null,
        sn: data.sn || null
    };
}

function helpMessage() {
    return [
        `🤖 <b>Bot Admin Sean Top Up</b>`,
        ``,
        `Perintah yang tersedia:`,
        `• /saldo — Cek sisa saldo Digiflazz`,
        `• /produk — Cek semua SKU web vs status &amp; harga modal Digiflazz`,
        `• /cek <code>SKU</code> — Cek detail 1 SKU di Digiflazz (cth: <code>/cek WDP</code>)`,
        `• /cari <code>KATA</code> — Cari produk di katalog Digiflazz (cth: <code>/cari mobile legends</code>)`,
        `• /orders — Lihat 10 pesanan terbaru`,
        `• /kirim <code>INVOICE</code> — Approve &amp; kirim pesanan ke Digiflazz (cth: <code>/kirim SEAN-123456</code>)`,
        `• /help — Tampilkan menu bantuan ini`
    ].join('\n');
}

export default async function handler(req, res) {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    // 1. Setup Webhook sekali klik via browser:
    //    GET /api/telegram?setup=1&secret=WEBHOOK_SECRET
    if (req.method === 'GET' && req.query.setup === '1') {
        const expectedSecret = process.env.WEBHOOK_SECRET || process.env.ADMIN_PASSWORD;
        if (!expectedSecret || req.query.secret !== expectedSecret) {
            return res.status(403).json({ ok: false, message: 'Secret salah! Tambahkan &secret=WEBHOOK_SECRET di URL.' });
        }
        if (!token) {
            return res.status(500).json({ ok: false, message: 'TELEGRAM_BOT_TOKEN belum dipasang di Environment Variables Vercel.' });
        }
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const webhookUrl = `https://${host}/api/telegram`;
        const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl })
        });
        const j = await r.json();
        return res.status(200).json({
            ok: j.ok,
            webhookUrl,
            telegramResponse: j,
            allowedChatIds: getAllowedChatIds()
        });
    }

    if (req.method !== 'POST') {
        return res.status(200).json({ ok: true, message: 'Sean Top Up Telegram Bot Webhook aktif.' });
    }

    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) {
        return res.status(200).json({ ok: true });
    }

    const chatId = String(msg.chat.id);
    const allowed = getAllowedChatIds();
    const text = msg.text.trim();
    const [rawCmd, ...argParts] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().split('@')[0];
    const arg = argParts.join(' ').trim();

    // Perintah /id tetap bisa dipanggil siapa saja untuk mengetahui Chat ID sendiri
    if (cmd === '/id') {
        await sendTelegram(chatId, `🆔 Chat ID kamu: <code>${escTg(chatId)}</code>\nPasang angka ini di Environment Variable <code>TELEGRAM_CHAT_ID</code> pada Vercel.`);
        return res.status(200).json({ ok: true });
    }

    // Proteksi: hanya Chat ID admin yang boleh akses perintah
    if (allowed.length === 0 || !allowed.includes(chatId)) {
        await sendTelegram(chatId, `⛔ Akses ditolak. Chat ID kamu (<code>${escTg(chatId)}</code>) belum terdaftar di <code>TELEGRAM_CHAT_ID</code>.`);
        return res.status(200).json({ ok: true });
    }

    try {
        if (cmd === '/start' || cmd === '/help') {
            await sendTelegram(chatId, helpMessage());
        } else if (cmd === '/saldo') {
            const bal = await fetchDigiflazzBalance();
            if (!bal.ok) {
                await sendTelegram(chatId, `❌ <b>Gagal cek saldo Digiflazz</b>\n${escTg(bal.message)}`);
            } else {
                await sendTelegram(chatId, `💰 <b>Saldo Digiflazz Saat Ini</b>\n\nSisa Saldo: <b>${formatRp(bal.deposit)}</b>`);
            }
        } else if (cmd === '/cek') {
            if (!arg) {
                await sendTelegram(chatId, `ℹ️ Cara pakai: <code>/cek WDP</code> atau <code>/cek ML86</code>`);
            } else {
                const targetSku = arg.toUpperCase();
                const [catRes, webProducts] = await Promise.all([
                    fetchDigiflazzCatalog(),
                    fetchFirebaseJson('/products')
                ]);
                if (!catRes.ok) {
                    await sendTelegram(chatId, `❌ <b>Gagal konek Digiflazz</b>\n${escTg(catRes.message)}`);
                } else {
                    const item = catRes.list.find(p => p && String(p.buyer_sku_code || '').toUpperCase() === targetSku);
                    if (!item) {
                        await sendTelegram(chatId, `❌ SKU <code>${escTg(targetSku)}</code> tidak ditemukan di katalog Digiflazz.\nCoba cari dengan <code>/cari ${escTg(arg)}</code>`);
                    } else {
                        const active = item.buyer_product_status === true && item.seller_product_status === true;
                        const webProd = Array.isArray(webProducts)
                            ? webProducts.find(p => p && String(p.sku || '').toUpperCase() === targetSku)
                            : null;
                        const lines = [
                            `🔎 <b>Detail Produk Digiflazz</b>`,
                            ``,
                            `• SKU: <code>${escTg(item.buyer_sku_code)}</code>`,
                            `• Nama: <b>${escTg(item.product_name)}</b>`,
                            `• Brand: ${escTg(item.brand)} (${escTg(item.category)})`,
                            `• Harga Modal: <b>${formatRp(item.price)}</b>`,
                            `• Status: ${active ? '✅ AKTIF' : '⚠️ GANGGUAN / NONAKTIF'}`,
                            `• Cut Off: ${escTg(item.start_cut_off || '-')} s/d ${escTg(item.end_cut_off || '-')}`
                        ];
                        if (webProd) {
                            const profit = Number(webProd.price || 0) - Number(item.price || 0);
                            lines.push(``);
                            lines.push(`🏪 <b>Di Website Anda:</b>`);
                            lines.push(`• Nama Web: ${escTg(webProd.name)}`);
                            lines.push(`• Harga Jual: <b>${formatRp(webProd.price)}</b>`);
                            lines.push(`• Estimasi Margin: <b>${profit >= 0 ? '+' : ''}${formatRp(profit)}</b>`);
                        }
                        await sendTelegram(chatId, lines.join('\n'));
                    }
                }
            }
        } else if (cmd === '/cari') {
            if (!arg) {
                await sendTelegram(chatId, `ℹ️ Cara pakai: <code>/cari mobile legends</code> atau <code>/cari weekly</code>`);
            } else {
                const catRes = await fetchDigiflazzCatalog();
                if (!catRes.ok) {
                    await sendTelegram(chatId, `❌ <b>Gagal konek Digiflazz</b>\n${escTg(catRes.message)}`);
                } else {
                    const q = arg.toLowerCase();
                    const matches = catRes.list.filter(p =>
                        p && (
                            String(p.product_name || '').toLowerCase().includes(q) ||
                            String(p.buyer_sku_code || '').toLowerCase().includes(q) ||
                            String(p.brand || '').toLowerCase().includes(q)
                        )
                    ).sort((a, b) => (a.price || 0) - (b.price || 0));

                    if (matches.length === 0) {
                        await sendTelegram(chatId, `❌ Tidak ada produk Digiflazz yang cocok dengan "<b>${escTg(arg)}</b>".`);
                    } else {
                        const top = matches.slice(0, 15);
                        const rows = top.map(p => {
                            const ok = p.buyer_product_status && p.seller_product_status ? '✅' : '⚠️';
                            return `${ok} <code>${escTg(p.buyer_sku_code)}</code> — ${escTg(p.product_name)} (<b>${formatRp(p.price)}</b>)`;
                        });
                        await sendTelegram(
                            chatId,
                            `🔎 <b>Hasil Pencarian "${escTg(arg)}"</b> (${matches.length} ditemukan, tampil ${top.length}):\n\n` + rows.join('\n')
                        );
                    }
                }
            }
        } else if (cmd === '/produk') {
            const [catRes, webProducts] = await Promise.all([
                fetchDigiflazzCatalog(),
                fetchFirebaseJson('/products')
            ]);
            if (!catRes.ok) {
                await sendTelegram(chatId, `❌ <b>Gagal konek Digiflazz</b>\n${escTg(catRes.message)}`);
            } else if (!Array.isArray(webProducts) || webProducts.length === 0) {
                await sendTelegram(chatId, `⚠️ Daftar produk di Firebase kosong.`);
            } else {
                const bySku = new Map();
                catRes.list.forEach(p => {
                    if (p && p.buyer_sku_code) bySku.set(String(p.buyer_sku_code).toUpperCase(), p);
                });
                const rows = webProducts.map(wp => {
                    const sku = String(wp.sku || '').toUpperCase();
                    const dp = bySku.get(sku);
                    if (!dp) {
                        return `❌ <code>${escTg(sku)}</code> ${escTg(wp.name)} — <b>TIDAK ADA di Digiflazz</b>`;
                    }
                    const active = dp.buyer_product_status && dp.seller_product_status;
                    const profit = Number(wp.price || 0) - Number(dp.price || 0);
                    const icon = !active ? '⚠️' : (profit < 0 ? '🔻' : '✅');
                    return `${icon} <code>${escTg(sku)}</code> ${escTg(wp.name)}\n    Modal: ${formatRp(dp.price)} | Jual: ${formatRp(wp.price)} (Untung: <b>${formatRp(profit)}</b>)`;
                });
                await sendTelegram(
                    chatId,
                    `📦 <b>Cek Produk Web vs Digiflazz (${webProducts.length} SKU)</b>\n\n` + rows.join('\n')
                );
            }
        } else if (cmd === '/orders') {
            const ordersObj = await fetchFirebaseJson('/orders');
            const list = ordersObj && typeof ordersObj === 'object'
                ? Object.values(ordersObj).filter(o => o && o.invoiceId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 10)
                : [];
            if (list.length === 0) {
                await sendTelegram(chatId, `🧾 Belum ada pesanan tercatat di Firebase.`);
            } else {
                const rows = list.map(o => {
                    const st = o.status === 'PAID' ? '✅ LUNAS' : '⏳ PENDING';
                    const dg = o.deliveryStatus === 'SENT' ? '🚀 Terkirim' : (o.deliveryStatus === 'FAILED' ? '❌ Gagal' : '—');
                    return `• <code>${escTg(o.invoiceId)}</code> | ${st} | ${dg}\n  ${escTg(o.item)} (${formatRp(o.totalPrice)}) — ${escTg(o.nickname || o.userId)}`;
                });
                await sendTelegram(chatId, `🧾 <b>10 Pesanan Terbaru Sean Top Up</b>\n\n` + rows.join('\n\n'));
            }
        } else if (cmd === '/kirim') {
            if (!arg) {
                await sendTelegram(chatId, `ℹ️ Cara pakai: <code>/kirim SEAN-123456</code>`);
            } else {
                const invId = arg.toUpperCase();
                const order = await fetchFirebaseJson(`/orders/${encodeURIComponent(invId)}`);
                if (!order || !order.invoiceId) {
                    await sendTelegram(chatId, `❌ Invoice <code>${escTg(invId)}</code> tidak ditemukan di Firebase.`);
                } else {
                    const digi = await processDigiflazzOrder(order);
                    const deliveryStatus = digi.success ? 'SENT' : 'FAILED';
                    const patchUrl = firebaseUrl(`/orders/${encodeURIComponent(invId)}`);
                    if (patchUrl) {
                        await fetch(patchUrl, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                status: 'PAID',
                                paidAt: Date.now(),
                                deliveryStatus,
                                digiflazzMessage: digi.message,
                                digiflazzResult: digi
                            })
                        });
                    }
                    const icon = digi.success ? '✅' : '❌';
                    await sendTelegram(
                        chatId,
                        `${icon} <b>Proses Digiflazz: ${escTg(invId)}</b>\n\n` +
                        `• Item: ${escTg(order.item)} (<code>${escTg(order.sku)}</code>)\n` +
                        `• Akun: ${escTg(order.nickname || '-')} (${escTg(order.userId)} / ${escTg(order.zoneId)})\n` +
                        `• Status Digiflazz: <b>${escTg(digi.status)}</b>\n` +
                        `• Pesan: ${escTg(digi.message)}` +
                        (digi.sn ? `\n• SN: <code>${escTg(digi.sn)}</code>` : '')
                    );
                }
            }
        } else {
            await sendTelegram(chatId, `❓ Perintah tidak dikenal.\n\n` + helpMessage());
        }
    } catch (err) {
        await sendTelegram(chatId, `⚠️ Terjadi error saat memproses perintah: ${escTg(err.message)}`);
    }

    return res.status(200).json({ ok: true });
}
