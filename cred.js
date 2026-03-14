function getAuthParams(twofa) {
    return {
        userid: 'FA73555',
        password: 'Dmt@jan26',
        twoFA: twofa,
        vendor_code: 'FA73555_U',
        api_secret: '913f016eb67cb2c354de9cf7965bc0ff',
        imei: '9840998409'
    };
}

module.exports = getAuthParams;
