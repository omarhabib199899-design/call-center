const fs = require("fs");
const path = require("path");

const LICENSE_FILE = path.join(__dirname, "./license.json");

const checkLicense = async (req, res, next) => {
  try {
    const currentDomain = getCurrentDomain(req);
    let needUpdate = false;

   
    if (!fs.existsSync(LICENSE_FILE)) {
      console.log("⚠️ License file not found → Creating new one...");
      needUpdate = true;
    } else {
      
      const fileContent = fs.readFileSync(LICENSE_FILE, 'utf8');
      const licenseData = JSON.parse(fileContent);

      
      if (licenseData.domain !== currentDomain) {
        console.log(`🔄 Domain changed: ${licenseData.domain} → ${currentDomain}`);
        needUpdate = true;
      }
    }

 
    if (needUpdate) {
      const licenseData = {
        activatedAt: new Date().toISOString(),
        domain: currentDomain,           
        product: "whatscrm",
        note: "Auto updated"
      };

      fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2));
      console.log(`✅ License file ${needUpdate ? 'updated' : 'created'} with domain:`, currentDomain);
    } else {
      console.log("✅ License file is valid");
    }

    
    return next();
  } catch (err) {
    console.error("❌ License check error:", err);
    
    return next();
  }
};

function getCurrentDomain(req = {}) {
  let domain = 
    req.headers?.host || 
    req.get?.('host') || 
    req.hostname || 
    process.env.DOMAIN || 
    "localhost";

 
  domain = domain.split(':')[0];

  
  if (domain.startsWith('www.')) {
    domain = domain.substring(4);
  }

  return domain;
}


const createLicenseFile = (data = {}) => {
  try {
    const licenseData = {
      activatedAt: new Date().toISOString(),
      domain: data.domain || getCurrentDomain(),
      product: data.product || "whatscrm",
      note: "Manually created"
    };

    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2));
    console.log("✅ License file created manually with domain:", licenseData.domain);
    return true;
  } catch (err) {
    console.error("❌ Error creating license file:", err);
    return false;
  }
};

module.exports = { checkLicense, createLicenseFile };