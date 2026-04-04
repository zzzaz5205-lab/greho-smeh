const socket = io();
const API_KEY = "AIzaSyCKm52vEfIM9_hiqRykt4XCWweh2UgiIrY";

async function speak(text) {
    try {
        const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${API_KEY}`, {
            method: 'POST',
            body: JSON.stringify({
                input: { text },
                voice: { languageCode: 'ru-RU', ssmlGender: 'MALE', name: 'ru-RU-Wavenet-B' },
                audioConfig: { audioEncoding: 'MP3' }
            })
        });
        const data = await response.json();
        const audio = new Audio("data:audio/mp3;base64," + data.audioContent);
        audio.play();
    } catch (e) { console.error("TTS Error", e); }
}

// Функционал таймера
function startTimer(duration, callback) {
    let timeLeft = duration;
    const bar = document.getElementById('timer-bar');
    if (bar) bar.style.width = '100%';
    
    const interval = setInterval(() => {
        timeLeft--;
        if (bar) bar.style.width = (timeLeft / duration * 100) + '%';
        if (timeLeft <= 0) {
            clearInterval(interval);
            if (callback) callback();
        }
    }, 1000);
}
