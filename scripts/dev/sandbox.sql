-- [CUSTOM] Run ONLY on the dev database copy (setup-dev.sh does this for you).
-- Removes every credential the copy could use to reach real customers,
-- WhatsApp numbers, Facebook pages or Instagram accounts. Chats, messages,
-- agents and settings stay, so the design can be worked on with real data.
-- Every statement names the dev database explicitly (__DEV_DB__), so even if
-- this were opened while the production database is selected it could only
-- touch the dev copy.

UPDATE `__DEV_DB__`.instagram_accounts SET access_token = '';
UPDATE `__DEV_DB__`.messenger_accounts SET page_access_token = '', user_access_token = '';
UPDATE `__DEV_DB__`.meta_api SET access_token = '';
UPDATE `__DEV_DB__`.telegram_session SET session = NULL, status = 'INACTIVE';
UPDATE `__DEV_DB__`.smtp SET password = '';
DELETE FROM `__DEV_DB__`.fcm_tokens;
UPDATE `__DEV_DB__`.instance SET status = 'INACTIVE';
UPDATE `__DEV_DB__`.web_private SET insta_app_secret = '', messenger_app_secret = '';
