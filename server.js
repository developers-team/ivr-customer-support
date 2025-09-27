// IVR Customer Support System
// Interactive Voice Response system for automated customer service
// Author: Your Name
// License: MIT

const express = require('express');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const bodyParser = require('body-parser');
const morgan = require('morgan');
const { Pool } = require('pg');
const redis = require('redis');
const winston = require('winston');
const cors = require('cors');
require('dotenv').config();

// Initialize Express
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(morgan('combined'));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ivr_system'
});

// Redis client for session management
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.connect().catch(console.error);

// Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'ivr.log' }),
        new winston.transports.Console({
            format: winston.format.colorize()
        })
    ]
});

// Call tracking
const activeCalls = new Map();

// Main IVR entry point
app.post('/ivr/welcome', async (req, res) => {
    const twiml = new VoiceResponse();
    const { CallSid, From, To } = req.body;
    
    try {
        // Log call
        await logCall(CallSid, From, To, 'incoming');
        
        // Store call session
        await redisClient.set(`call:${CallSid}`, JSON.stringify({
            from: From,
            to: To,
            startTime: new Date(),
            menuLevel: 'main'
        }), 'EX', 3600);
        
        // Welcome message
        const gather = twiml.gather({
            numDigits: 1,
            action: '/ivr/menu',
            method: 'POST',
            timeout: 5,
            language: 'en-US'
        });
        
        gather.say({
            voice: 'Polly.Joanna',
            language: 'en-US'
        }, 'Welcome to our customer support line. Thank you for calling.');
        
        gather.pause({ length: 1 });
        
        gather.say({
            voice: 'Polly.Joanna'
        }, 'Press 1 for account information. Press 2 for technical support. Press 3 for billing inquiries. Press 4 to speak with an agent. Press 9 to repeat this menu.');
        
        // If no input, repeat
        twiml.redirect('/ivr/welcome');
        
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        logger.error('IVR Welcome Error:', error);
        handleError(twiml, res);
    }
});

// Menu handler
app.post('/ivr/menu', async (req, res) => {
    const { Digits, CallSid } = req.body;
    const twiml = new VoiceResponse();
    
    try {
        // Get session data
        const sessionData = await redisClient.get(`call:${CallSid}`);
        const session = JSON.parse(sessionData);
        
        switch (Digits) {
            case '1':
                await handleAccountInfo(twiml, CallSid, session);
                break;
            case '2':
                await handleTechnicalSupport(twiml, CallSid, session);
                break;
            case '3':
                await handleBilling(twiml, CallSid, session);
                break;
            case '4':
                await transferToAgent(twiml, CallSid, session);
                break;
            case '9':
                twiml.redirect('/ivr/welcome');
                break;
            default:
                twiml.say({
                    voice: 'Polly.Joanna'
                }, 'Invalid option. Please try again.');
                twiml.redirect('/ivr/welcome');
        }
        
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        logger.error('Menu Handler Error:', error);
        handleError(twiml, res);
    }
});

// Account Information Handler
async function handleAccountInfo(twiml, callSid, session) {
    const gather = twiml.gather({
        numDigits: 10,
        action: '/ivr/account/verify',
        method: 'POST',
        timeout: 10
    });
    
    gather.say({
        voice: 'Polly.Joanna'
    }, 'Please enter your 10-digit account number followed by the pound key.');
    
    // Update session
    session.menuLevel = 'account';
    await redisClient.set(`call:${callSid}`, JSON.stringify(session), 'EX', 3600);
    
    twiml.say('We did not receive your account number.');
    twiml.redirect('/ivr/menu');
}

// Technical Support Handler
async function handleTechnicalSupport(twiml, callSid, session) {
    const gather = twiml.gather({
        numDigits: 1,
        action: '/ivr/tech/category',
        method: 'POST'
    });
    
    gather.say({
        voice: 'Polly.Joanna'
    }, 'For internet issues, press 1. For phone service, press 2. For cable TV, press 3. To go back, press 0.');
    
    session.menuLevel = 'tech';
    await redisClient.set(`call:${callSid}`, JSON.stringify(session), 'EX', 3600);
}

// Billing Handler
async function handleBilling(twiml, callSid, session) {
    const gather = twiml.gather({
        numDigits: 1,
        action: '/ivr/billing/option',
        method: 'POST'
    });
    
    gather.say({
        voice: 'Polly.Joanna'
    }, 'To hear your current balance, press 1. To make a payment, press 2. For payment history, press 3. To go back, press 0.');
    
    session.menuLevel = 'billing';
    await redisClient.set(`call:${callSid}`, JSON.stringify(session), 'EX', 3600);
}

// Transfer to Agent
async function transferToAgent(twiml, callSid, session) {
    try {
        // Check business hours
        const isBusinessHours = checkBusinessHours();
        
        if (!isBusinessHours) {
            twiml.say({
                voice: 'Polly.Joanna'
            }, 'Our agents are currently unavailable. Our business hours are Monday through Friday, 9 AM to 6 PM Eastern Time. Please call back during business hours or leave a message after the beep.');
            
            twiml.record({
                maxLength: 120,
                action: '/ivr/voicemail',
                method: 'POST',
                transcribe: true,
                transcribeCallback: '/ivr/transcription'
            });
            
            return;
        }
        
        // Get available agent
        const agent = await getAvailableAgent();
        
        if (agent) {
            twiml.say({
                voice: 'Polly.Joanna'
            }, 'Please wait while we connect you to the next available agent.');
            
            twiml.play({ loop: 1 }, 'http://com.twilio.sounds.music.s3.amazonaws.com/ClockworkWaltz.mp3');
            
            // Create conference
            twiml.dial().conference({
                startConferenceOnEnter: true,
                endConferenceOnExit: false,
                waitUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
                statusCallback: '/ivr/conference/status',
                statusCallbackEvent: 'start end join leave mute hold'
            }, `support-${callSid}`);
            
            // Notify agent
            await notifyAgent(agent, callSid);
            
        } else {
            // Put in queue
            twiml.say({
                voice: 'Polly.Joanna'
            }, 'All of our agents are currently assisting other customers. You are number 3 in queue. Please hold and we will connect you shortly.');
            
            twiml.enqueue({
                waitUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
                action: '/ivr/queue/connect'
            }, 'support');
        }
        
        // Log transfer attempt
        await logTransfer(callSid, session.from, agent ? agent.id : 'queue');
        
    } catch (error) {
        logger.error('Transfer Error:', error);
        twiml.say('We apologize for the inconvenience. Please try again later.');
    }
}

// Account Verification
app.post('/ivr/account/verify', async (req, res) => {
    const { Digits, CallSid } = req.body;
    const twiml = new VoiceResponse();
    
    try {
        // Verify account in database
        const account = await verifyAccount(Digits);
        
        if (account) {
            twiml.say({
                voice: 'Polly.Joanna'
            }, `Thank you. Your current balance is ${account.balance} dollars. Your next payment of ${account.nextPayment} dollars is due on ${account.dueDate}.`);
            
            const gather = twiml.gather({
                numDigits: 1,
                action: '/ivr/account/options',
                method: 'POST'
            });
            
            gather.say('Press 1 to make a payment. Press 2 for payment history. Press 0 to return to main menu.');
            
        } else {
            twiml.say('Account number not found. Please try again.');
            twiml.redirect('/ivr/menu');
        }
        
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        logger.error('Account Verification Error:', error);
        handleError(twiml, res);
    }
});

// Voicemail Handler
app.post('/ivr/voicemail', async (req, res) => {
    const { CallSid, RecordingUrl, RecordingDuration } = req.body;
    const twiml = new VoiceResponse();
    
    try {
        // Save voicemail to database
        await saveVoicemail(CallSid, RecordingUrl, RecordingDuration);
        
        twiml.say({
            voice: 'Polly.Joanna'
        }, 'Thank you for your message. We will return your call within one business day. Goodbye.');
        
        twiml.hangup();
        
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        logger.error('Voicemail Error:', error);
        handleError(twiml, res);
    }
});

// Call Status Webhook
app.post('/ivr/status', async (req, res) => {
    const { CallSid, CallStatus, CallDuration, From, To } = req.body;
    
    try {
        await updateCallStatus(CallSid, CallStatus, CallDuration);
        
        // Clean up session
        if (CallStatus === 'completed' || CallStatus === 'failed') {
            await redisClient.del(`call:${CallSid}`);
            activeCalls.delete(CallSid);
        }
        
        res.status(200).send('OK');
        
    } catch (error) {
        logger.error('Status Update Error:', error);
        res.status(500).send('Error');
    }
});

// Analytics endpoint
app.get('/api/analytics/calls', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        
        const analytics = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_calls,
                AVG(duration) as avg_duration,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_calls,
                COUNT(CASE WHEN transferred_to_agent = true THEN 1 END) as transferred_calls
            FROM calls
            WHERE created_at BETWEEN $1 AND $2
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [start_date || '2024-01-01', end_date || new Date()]);
        
        res.json({
            success: true,
            data: analytics.rows
        });
        
    } catch (error) {
        logger.error('Analytics Error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Helper Functions
async function logCall(callSid, from, to, direction) {
    try {
        await pool.query(
            'INSERT INTO calls (call_sid, from_number, to_number, direction, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [callSid, from, to, direction, 'in-progress', new Date()]
        );
    } catch (error) {
        logger.error('Log Call Error:', error);
    }
}

async function updateCallStatus(callSid, status, duration) {
    try {
        await pool.query(
            'UPDATE calls SET status = $1, duration = $2, updated_at = $3 WHERE call_sid = $4',
            [status, duration, new Date(), callSid]
        );
    } catch (error) {
        logger.error('Update Status Error:', error);
    }
}

async function verifyAccount(accountNumber) {
    try {
        const result = await pool.query(
            'SELECT * FROM accounts WHERE account_number = $1',
            [accountNumber]
        );
        return result.rows[0];
    } catch (error) {
        logger.error('Verify Account Error:', error);
        return null;
    }
}

async function getAvailableAgent() {
    try {
        const result = await pool.query(
            'SELECT * FROM agents WHERE status = $1 ORDER BY last_call ASC LIMIT 1',
            ['available']
        );
        return result.rows[0];
    } catch (error) {
        logger.error('Get Agent Error:', error);
        return null;
    }
}

async function notifyAgent(agent, callSid) {
    try {
        await twilioClient.calls.create({
            url: `${process.env.BASE_URL}/agent/connect?callSid=${callSid}`,
            to: agent.phone_number,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: '/agent/status',
            statusCallbackMethod: 'POST'
        });
    } catch (error) {
        logger.error('Notify Agent Error:', error);
    }
}

async function saveVoicemail(callSid, recordingUrl, duration) {
    try {
        await pool.query(
            'INSERT INTO voicemails (call_sid, recording_url, duration, created_at) VALUES ($1, $2, $3, $4)',
            [callSid, recordingUrl, duration, new Date()]
        );
    } catch (error) {
        logger.error('Save Voicemail Error:', error);
    }
}

async function logTransfer(callSid, from, agentId) {
    try {
        await pool.query(
            'INSERT INTO transfers (call_sid, from_number, agent_id, created_at) VALUES ($1, $2, $3, $4)',
            [callSid, from, agentId, new Date()]
        );
    } catch (error) {
        logger.error('Log Transfer Error:', error);
    }
}

function checkBusinessHours() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    
    // Monday-Friday (1-5), 9 AM - 6 PM
    return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

function handleError(twiml, res) {
    twiml.say({
        voice: 'Polly.Joanna'
    }, 'We apologize for the technical difficulty. Please call back later.');
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'operational',
        service: 'IVR Customer Support System',
        version: '2.0.0'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`IVR System running on port ${PORT}`);
    console.log(`IVR System ready at http://localhost:${PORT}`);
});
