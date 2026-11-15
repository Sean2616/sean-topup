import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const notification = req.body;

    const orderId = notification.order_id;
    const statusCode = notification.status_code;
    const grossAmount = notification.gross_amount;
    const signatureKey = notification.signature_key;
    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;

    // Ambil data SKU dan ID MLBB yang kita titipkan tadi
    const buyerSkuCode = notification.custom_field1;
    const customerNo = notification.custom_field2;

    const midtransServerKey = process.env.MIDTRANS_SERVER_KEY;
    const digiUsername = process.env.DIGIFLAZZ_USERNAME;
    const digiApiKey = process.env.DIGIFLAZZ_API_KEY;

    // 1. VERIFIKASI KEAMANAN: Pastikan notifikasi benar-benar asli dari Midtrans
    const hash = crypto
        .createHash('sha512')
        .update(`${orderId}${statusCode}${grossAmount}${midtransServerKey}`)
        .digest('hex');

    if (hash !== signatureKey) {
        return res.status(403).json({ message: 'Signature Midtrans Tidak Valid!' });
    }

    // 2. Cek apakah status pembayaran sudah LUNAS (settlement / capture)
    const isPaid =
        transactionStatus === 'settlement' ||
        (transactionStatus === 'capture' && fraudStatus === 'accept');

    if (isPaid) {
        try {
            // 3. Buat Signature MD5 sesuai rumus wajib Digiflazz: md5(username + apiKey + ref_id)
            const digiSign = crypto
                .createHash('md5')
                .update(`${digiUsername}${digiApiKey}${orderId}`)
                .digest('hex');

            // 4. Tembak API Transaksi Digiflazz
            const digiResponse = await fetch('https://api.digiflazz.com/v1/transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: digiUsername,
                    buyer_sku_code: buyerSkuCode,
                    customer_no: customerNo,
                    ref_id: orderId,
                    sign: digiSign
                })
            });

            const digiData = await digiResponse.json();
            console.log('Hasil Top Up Digiflazz:', digiData);

            return res.status(200).json({
                status: 'OK',
                digiflazz_response: digiData
            });

        } catch (error) {
            console.error('Error saat menembak Digiflazz:', error);
            return res.status(500).json({ message: 'Gagal memproses ke Digiflazz' });
        }
    }

    // Jika status masih pending / expire / cancel, cukup balas OK ke Midtrans
    return res.status(200).json({ status: 'Status pembayaran: ' + transactionStatus });
}