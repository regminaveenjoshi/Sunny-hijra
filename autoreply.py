from telethon import TelegramClient, events

import os

api_id = int(os.environ["API_ID"])
api_hash = os.environ["API_HASH"]
TARGET_USERS = {
    "NotYourChatgpt",
    "Stfuleo",
    "Retired_Cheater"
}

messages = [
"Tumharii maki भोसड़ी में इतने बम मरेंगे पूरा duann duaan हो jyga",
"7  रंग kee सात कबूतर satto खा गई billii\nTeri ma tange uthaye or chode pura दिल्ली\n🤟😩💦😭🤣🥀💅🤟🤟😎",
"𝐓ᴜ 𝐆ᴜʟᴀ𝐌 𝐇ɪ 𝐓ʜɪ𝐊 𝐇ᴀɪ 𝐑ᴀɴᴅ𝐘k 🦮",
"चूत गोरी होगी तो\nतेरी रंडी बीवी को बुलाना लड़की की चूत में ऊंगली करुंगा\nअन्दर बाहर करुंगा सिफ 😊",
"𝐋ᴀɢᴛᴀ 𝐇ᴀɪ 𝐓ᴇʀɪ 𝐌ᴀᴀ 𝐂ʜᴏᴅɴɪ 𝐏ᴀᴅᴇɢɪ\n\n😁🔥🗣🔥🏃🔥🕺🔥",
"तेरी रण्डी बुआ जवान हो गईं बेटा 🤣🤣\nमेरा लंड ले रहि है 🤣🤣\nसोचे रहि है तेरी रण्डी बुआ पहले गांड में डालू या चूत में 🤣🤣🤣\n\nमेने कहा पहले मुंह में डाल वरना तेरी गांड़ फट जायेगी 🤣🤣😭",
"Teri माँ के भोसड़े पर इतने बल्ले मारूंगा की IPL जीत जायेगी",
"तू छोटा था तब तेरी मां का स्तन पान करता था मैं, उसके दूध में 60% क्रीम होता था, तू रोते हुए आता था और मैं तुझे लात मारके भागता था बोलता था हट साले मेरे लन्ड से निकले हुए मैल",
"घिनौनी रंडी के बच्चे तु बात बात पर अपनी माँ क्यूँ चुदवाता है मादरचोद",
"𝐋ᴀɢᴛᴀ 𝐇ᴀɪ 𝐓ᴇʀɪ 𝐌ᴀᴀ 𝐂ʜᴏᴅɴɪ 𝐏ᴀᴅᴇɢɪ"
]

user_indices = {}

client = TelegramClient('my_session', api_id, api_hash)

@client.on(events.NewMessage)
async def auto_reply(event):
if event.is_group:
sender = await event.get_sender()
if sender:
username = sender.username
user_id = str(sender.id)

identifier = username if username in TARGET_USERS else (user_id if user_id in TARGET_USERS else None)  
          
        if identifier:  
            if identifier not in user_indices:  
                user_indices[identifier] = 0  
              
            current_index = user_indices[identifier]  
            msg_to_send = messages[current_index]  
              
            await event.reply(msg_to_send)  
              
            user_indices[identifier] = (current_index + 1) % len(messages)

def main():
print("Bot is running...")
client.start()
client.run_until_disconnected()

if name == 'main':
main() how to use
