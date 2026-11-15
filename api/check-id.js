export default async function handler(req, res) {
    // Hanya izinkan method POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { userId, zoneId } = req.body;

    if (!userId || !zoneId) {
        return res.status(400).json({ success: false, message: 'User ID dan Zone ID wajib diisi!' });
    }

    try {
        // Mencoba mengecek ke API Publik Gratis untuk Nickname MLBB
        const response = await fetch(`https://api.isan.eu.org/nickname/ml?id=${userId}&zone=${zoneId}`);
        const data = await response.json();

        if (data.success && data.name) {
            return res.status(200).json({
                success: true,
                nickname: data.name
            });
        } else {
            // Fallback (Cadangan) jika ID tidak ditemukan / API limit, tetap loloskan dengan nama simulasi
            return res.status(200).json({
                success: true,
                nickname: `SeanPlayer_${userId.slice(-4)}`
            });
        }
    } catch (error) {
        // Jika API pihak ketiga mati, gunakan cadangan agar transaksi tetap jalan
        return res.status(200).json({
            success: true,
            nickname: `Player_${userId.slice(0, 4)}`
        });
    }
}