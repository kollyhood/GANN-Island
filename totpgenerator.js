const speakeasy = require('speakeasy');

// Function to generate TOTP
function generateTotp(secret) {
  const token = speakeasy.totp({
    secret: secret,
    encoding: 'base32'
  });
  return token;
}

module.exports = generateTotp;
