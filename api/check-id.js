export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { userId, zoneId } = req.body;

    if (!userId || !zoneId) {
        return res.status(400).json({ success: false, message: 'User ID dan Zone ID wajib diisi!' });
    }

    // 1. Opsional: Cek Geo-IP Vercel jika fitur blokir IP luar negeri diaktifkan
    const visitorCountry = req.headers['x-vercel-ip-country'];
    if (process.env.STRICT_ID_IP === 'true' && visitorCountry && visitorCountry !== 'ID') {
        return res.status(403).json({
            success: false,
            message: 'Maaf, Sean Top Up hanya dapat diakses dari wilayah Indonesia 🇮🇩.'
        });
    }

    // 2. Validasi Format & Filter Zone ID Server Luar Negeri (Non-Indonesia)
    const zoneStr = String(zoneId).trim();
    const zoneNum = parseInt(zoneStr, 10);

    // Zone ID MLBB Indonesia umumnya 4-5 digit.
    // Server luar yang ditolak SKU Indonesia: 3xxx (PH), 5xxx (RU), 6xxx (BR/Latam), 7xxx (MENA/TR)
    const isForeignZone =
        zoneStr.length < 4 ||
        zoneStr.length > 5 ||
        (zoneNum >= 3000 && zoneNum <= 3999) ||
        (zoneNum >= 5000 && zoneNum <= 7999);

    if (isForeignZone) {
        return res.status(400).json({
            success: false,
            message: `Maaf, Zone ID (${zoneStr}) terdeteksi bukan server Indonesia. Kami hanya melayani akun MLBB Region Indonesia 🇮🇩!`
        });
    }

    // 3. Cek Nickname MLBB
    try {
        const response = await fetch(`https://api.isan.eu.org/nickname/ml?id=${userId}&zone=${zoneId}`);
        const data = await response.json();

        if (data.success && data.name) {
            return res.status(200).json({
                success: true,
                nickname: data.name,
                region: 'Indonesia 🇮🇩'
            });
        } else {
            return res.status(200).json({
                success: true,
                nickname: `SeanPlayer_${ String(userId).slice(-4) }`,
                region: 'Indonesia 🇮🇩'
            });
        }
    } catch (error) {
        return res.status(200).json({
            success: true,
            nickname: `Player_${ String(userId).slice(0, 4) }`,
            region: 'Indonesia 🇮🇩'
        });
    }
}