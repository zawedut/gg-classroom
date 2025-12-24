require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const axios = require('axios');

// สิทธิ์ที่ต้องการเข้าถึง
const SCOPES = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/drive.readonly'
];

const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// ตัวแปร global
let authClient = null;
let classroom = null;
let drive = null;
let coursesCache = [];

// สร้าง readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise(resolve => rl.question(question, resolve));

/** --- ส่วนการจัดการ Login --- **/
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) { return null; }
}

async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) return client;
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
        // บังคับให้เลือก account ทุกครั้ง
        additionalParameters: {
            prompt: 'select_account'
        }
    });
    if (client.credentials) await saveCredentials(client);
    return client;
}

/** --- ส่วน Typhoon AI --- **/
async function summarizeWithTyphoon(text) {
    try {
        const response = await axios.post('https://api.opentyphoon.ai/v1/chat/completions', {
            model: "typhoon-v2.1-12b-instruct",
            messages: [
                {
                    role: "system",
                    content: `คุณคือผู้ช่วยนักเรียนที่เก่งมาก ช่วยสรุปงานการบ้านให้ครบถ้วนและชัดเจน โดยตอบในรูปแบบนี้:

📌 **ประเภทงาน**: (เช่น รายงาน, แบบฝึกหัด, โปรเจค, นำเสนอ)
📝 **สิ่งที่ต้องทำ**: (ลิสต์ขั้นตอนชัดเจน)
⏰ **เวลาที่ควรใช้**: (ประมาณการ)
💡 **เคล็ดลับ**: (คำแนะนำสั้นๆ เพื่อทำงานให้ดี)

ตอบเป็นภาษาไทย กระชับ อ่านง่าย`
                },
                { role: "user", content: text }
            ],
            temperature: 0.3,
            max_tokens: 1000
        }, {
            headers: { 'Authorization': `Bearer ${process.env.TYPHOON_API_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        return "❌ AI ไม่สามารถสรุปได้: " + (e.response?.data?.error?.message || e.message);
    }
}

async function readFileWithVision(base64Data, mimeType, fileName) {
    try {
        const isImage = mimeType.startsWith('image/');
        const response = await axios.post('https://api.opentyphoon.ai/v1/chat/completions', {
            model: "typhoon-v2.1-12b-instruct",
            messages: [
                {
                    role: "system",
                    content: "คุณคือผู้ช่วยอ่านเอกสาร อ่านและสรุปเนื้อหาจากไฟล์ที่ได้รับให้เข้าใจง่าย ตอบเป็นภาษาไทย"
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `อ่านและสรุปเนื้อหาจากไฟล์นี้: ${fileName}` },
                        {
                            type: "image_url",
                            image_url: { url: `data:${mimeType};base64,${base64Data}` }
                        }
                    ]
                }
            ],
            max_tokens: 2000
        }, {
            headers: { 'Authorization': `Bearer ${process.env.TYPHOON_API_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        return `❌ ไม่สามารถอ่านไฟล์ได้: ${e.response?.data?.error?.message || e.message}`;
    }
}

/** --- ส่วนดึงข้อมูล Classroom --- **/
async function fetchCourses() {
    if (coursesCache.length > 0) return coursesCache;

    console.log('\n⏳ กำลังโหลดรายวิชา...');
    const res = await classroom.courses.list({ courseStates: 'ACTIVE' });
    coursesCache = res.data.courses || [];
    return coursesCache;
}

async function fetchCourseWorks(courseId) {
    const res = await classroom.courses.courseWork.list({ courseId });
    return res.data.courseWork || [];
}

async function fetchAttachment(fileId) {
    try {
        const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' });
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        return {
            name: meta.data.name,
            mimeType: meta.data.mimeType,
            data: Buffer.from(res.data).toString('base64')
        };
    } catch (e) {
        console.log(`   ⚠️ ไม่สามารถดึงไฟล์ได้: ${e.message}`);
        return null;
    }
}

/** --- ตัวเลือกเมนู --- **/

// ตัวเลือก 1: แสดงรายวิชาทั้งหมด
async function option1_ListCourses() {
    const courses = await fetchCourses();

    if (courses.length === 0) {
        console.log('\n❌ ไม่พบวิชาเรียน');
        return;
    }

    console.log('\n╭─────────────────────────────────────────────────╮');
    console.log('│           📚 รายวิชาทั้งหมด                      │');
    console.log('├─────────────────────────────────────────────────┤');

    courses.forEach((course, i) => {
        const name = course.name.length > 40 ? course.name.substring(0, 37) + '...' : course.name;
        console.log(`│  ${(i + 1).toString().padStart(2)}. ${name.padEnd(42)} │`);
    });

    console.log('╰─────────────────────────────────────────────────╯');
    console.log(`\n✅ พบทั้งหมด ${courses.length} วิชา`);
}

// ตัวเลือก 2: แสดงงานแต่ละวิชา
async function option2_ListAssignments() {
    const courses = await fetchCourses();

    if (courses.length === 0) {
        console.log('\n❌ ไม่พบวิชาเรียน');
        return;
    }

    // แสดงรายวิชาให้เลือก
    console.log('\n📚 เลือกวิชา:');
    courses.forEach((course, i) => {
        console.log(`   ${i + 1}. ${course.name}`);
    });
    console.log('   0. กลับเมนูหลัก');

    const choice = await ask('\n🔢 เลือกวิชา: ');
    const idx = parseInt(choice) - 1;

    if (choice === '0' || isNaN(idx) || idx < 0 || idx >= courses.length) {
        return;
    }

    const course = courses[idx];
    console.log(`\n⏳ กำลังโหลดงานของวิชา "${course.name}"...`);

    const works = await fetchCourseWorks(course.id);

    if (works.length === 0) {
        console.log('\n📭 ไม่มีงานที่สั่งในวิชานี้');
        return;
    }

    console.log('\n╭─────────────────────────────────────────────────────────╮');
    console.log(`│  📝 งานในวิชา: ${course.name.substring(0, 38).padEnd(38)} │`);
    console.log('├─────────────────────────────────────────────────────────┤');

    works.forEach((work, i) => {
        const title = work.title.length > 45 ? work.title.substring(0, 42) + '...' : work.title;
        let dueStr = '';
        if (work.dueDate) {
            dueStr = `(${work.dueDate.day}/${work.dueDate.month}/${work.dueDate.year})`;
        }
        console.log(`│  ${(i + 1).toString().padStart(2)}. ${title.padEnd(45)} ${dueStr.padEnd(12)} │`);
    });

    console.log('╰─────────────────────────────────────────────────────────╯');
    console.log(`\n✅ พบทั้งหมด ${works.length} งาน`);
}

// ตัวเลือก 3: สรุปเนื้อหางาน
async function option3_SummarizeAssignment() {
    const courses = await fetchCourses();

    if (courses.length === 0) {
        console.log('\n❌ ไม่พบวิชาเรียน');
        return;
    }

    // เลือกวิชา
    console.log('\n📚 เลือกวิชา:');
    courses.forEach((course, i) => {
        console.log(`   ${i + 1}. ${course.name}`);
    });
    console.log('   0. กลับเมนูหลัก');

    const courseChoice = await ask('\n🔢 เลือกวิชา: ');
    const courseIdx = parseInt(courseChoice) - 1;

    if (courseChoice === '0' || isNaN(courseIdx) || courseIdx < 0 || courseIdx >= courses.length) {
        return;
    }

    const course = courses[courseIdx];
    console.log(`\n⏳ กำลังโหลดงาน...`);

    const works = await fetchCourseWorks(course.id);

    if (works.length === 0) {
        console.log('\n📭 ไม่มีงานที่สั่งในวิชานี้');
        return;
    }

    // เลือกงาน
    console.log('\n📝 เลือกงาน:');
    works.forEach((work, i) => {
        let dueStr = '';
        if (work.dueDate) {
            dueStr = ` (กำหนดส่ง: ${work.dueDate.day}/${work.dueDate.month}/${work.dueDate.year})`;
        }
        console.log(`   ${i + 1}. ${work.title}${dueStr}`);
    });
    console.log('   0. กลับ');

    const workChoice = await ask('\n🔢 เลือกงาน: ');
    const workIdx = parseInt(workChoice) - 1;

    if (workChoice === '0' || isNaN(workIdx) || workIdx < 0 || workIdx >= works.length) {
        return;
    }

    const work = works[workIdx];

    console.log('\n' + '═'.repeat(60));
    console.log(`📋 งาน: ${work.title}`);
    console.log('═'.repeat(60));

    // แสดงข้อมูลพื้นฐาน
    if (work.description) {
        console.log(`\n📄 คำอธิบาย:\n${work.description}`);
    }

    if (work.dueDate) {
        console.log(`\n📅 กำหนดส่ง: ${work.dueDate.day}/${work.dueDate.month}/${work.dueDate.year}`);
    }

    // ตรวจสอบไฟล์แนบ
    const materials = work.materials || [];
    const attachments = [];

    for (const material of materials) {
        if (material.driveFile) {
            attachments.push({
                type: 'drive',
                id: material.driveFile.driveFile.id,
                title: material.driveFile.driveFile.title
            });
        } else if (material.link) {
            console.log(`\n🔗 ลิงก์: ${material.link.url}`);
        }
    }

    // อ่านไฟล์แนบด้วย AI Vision
    if (attachments.length > 0) {
        console.log(`\n📎 ไฟล์แนบ: ${attachments.length} ไฟล์`);

        for (const att of attachments) {
            console.log(`\n   📁 ${att.title}`);
            console.log(`   ⏳ กำลังให้ AI อ่านไฟล์...`);

            const file = await fetchAttachment(att.id);
            if (file && (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf')) {
                const content = await readFileWithVision(file.data, file.mimeType, file.name);
                console.log(`   📖 เนื้อหา:\n${content.split('\n').map(l => '      ' + l).join('\n')}`);
            } else if (file) {
                console.log(`   ⚠️ ไม่รองรับไฟล์ประเภท ${file.mimeType}`);
            }
        }
    }

    // สรุปทั้งหมดด้วย AI
    console.log('\n' + '─'.repeat(60));
    console.log('✨ AI กำลังสรุปงาน...');

    let summaryInput = `หัวข้อ: ${work.title}\n`;
    if (work.description) summaryInput += `คำอธิบาย: ${work.description}\n`;
    if (work.dueDate) summaryInput += `กำหนดส่ง: ${work.dueDate.day}/${work.dueDate.month}/${work.dueDate.year}\n`;

    const summary = await summarizeWithTyphoon(summaryInput);
    console.log(`\n🎯 สรุป:\n${summary}`);
    console.log('\n' + '═'.repeat(60));
}

/** --- เมนูหลัก --- **/
function showMenu() {
    console.log('\n╭─────────────────────────────────────╮');
    console.log('│      📚 Classroom AI Assistant      │');
    console.log('├─────────────────────────────────────┤');
    console.log('│  1. ดูรายวิชาทั้งหมด                 │');
    console.log('│  2. ดูงานแต่ละวิชา                   │');
    console.log('│  3. สรุปเนื้อหางาน (AI อ่าน PDF/รูป) │');
    console.log('│  0. ออกจากโปรแกรม                   │');
    console.log('╰─────────────────────────────────────╯');
}

async function main() {
    try {
        console.log('🚀 กำลังเชื่อมต่อ Google Classroom...');
        authClient = await authorize();
        classroom = google.classroom({ version: 'v1', auth: authClient });
        drive = google.drive({ version: 'v3', auth: authClient });
        console.log('✅ เชื่อมต่อสำเร็จ!');

        let running = true;

        while (running) {
            showMenu();
            const choice = await ask('\n🔢 เลือกเมนู: ');

            switch (choice.trim()) {
                case '1':
                    await option1_ListCourses();
                    break;
                case '2':
                    await option2_ListAssignments();
                    break;
                case '3':
                    await option3_SummarizeAssignment();
                    break;
                case '0':
                    running = false;
                    console.log('\n👋 ลาก่อน!');
                    break;
                default:
                    console.log('\n⚠️ กรุณาเลือก 0-3');
            }
        }

        rl.close();

    } catch (err) {
        console.error('❌ เกิดข้อผิดพลาด:', err.message);
        rl.close();
    }
}

main();