import 'dotenv/config'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import googleSheetService from './sheets.js'
import groqService from './ai-chat.js'
import chatHistoryService from './chat-history.js'
import scheduledMessageService from './scheduled-messages.js'

const PORT = process.env.PORT ?? 3008

const userSession = new Map() // guarda el último brochure solicitado por usuario

const dynamicFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, provider }) => {
        const flows = await googleSheetService.getFlows()
        const userInput = ctx.body.toLowerCase().trim()
        const phoneNumber = ctx.from

        // Buscar coincidencia con palabras clave de la hoja
        const triggeredFlow = flows.find(f => {
            if (!f.addKeyword) return false
            const sheetKeyword = f.addKeyword.toLowerCase().trim()
            return userInput.includes(sheetKeyword)
        })

        // 📄 Brochures por área
        const brochures = {
            'contable': {
                id: '184wOk8NESI1YOMxHyq7kVO6_RA39xPgM',
                nombre: 'brochure-contable.pdf',
                mensaje: '📊 Aquí tienes el brochure del área Contable.'
            },
            'legal': {
                id: '184wOk8NESI1YOMxHyq7kVO6_RA39xPgM',
                nombre: 'brochure-legal.pdf',
                mensaje: '⚖️ Aquí tienes el brochure del área Legal.'
            },
            'branding': {
                id: 'ID_BRANDING',
                nombre: 'brochure-branding.pdf',
                mensaje: '🎨 Aquí tienes el brochure del área de Branding.'
            },
            'página web': {
                id: 'ID_WEB',
                nombre: 'brochure-pagina-web.pdf',
                mensaje: '💻 Aquí tienes el brochure del servicio de Página Web (TI).'
            },
            'gestión humana': {
                id: 'ID_GH',
                nombre: 'brochure-gestion-humana.pdf',
                mensaje: '👥 Aquí tienes el brochure del área de Gestión Humana.'
            }
        }

        // Recuperar o crear sesión del usuario
        const session = userSession.get(phoneNumber) || {}

        // 🧠 Si el mensaje contiene "brochure" + nombre de área, guardamos ese contexto
        for (const area of Object.keys(brochures)) {
            if (userInput.includes('brochure') && userInput.includes(area)) {
                session.lastBrochure = area
                userSession.set(phoneNumber, session)
                console.log(`🗂️ Usuario ${phoneNumber} solicitó brochure de ${area}`)
                break
            }
        }

        // 📤 Si el usuario responde "sí" y hay un brochure pendiente, se envía
        if ((userInput === 'sí' || userInput === 'si' || userInput.includes('claro')) && session.lastBrochure) {
            const info = brochures[session.lastBrochure]
            const url = `https://drive.google.com/uc?export=download&id=${info.id}`

            await flowDynamic(info.mensaje)
            await provider.sendFile(phoneNumber, url, info.nombre, info.mensaje)
            console.log(`📎 Brochure ${info.nombre} enviado al usuario ${phoneNumber}`)

            session.lastBrochure = null // limpiamos para evitar duplicados
            userSession.set(phoneNumber, session)
        }

        // 💬 Flujo normal del prompt (respuestas desde Google Sheets)
        if (triggeredFlow) {
            const answer = triggeredFlow.addAnswer
            const mediaUrl = triggeredFlow.media && triggeredFlow.media.trim()

            await chatHistoryService.saveMessage(phoneNumber, 'user', userInput)
            await chatHistoryService.saveMessage(phoneNumber, 'assistant', answer)

            if (mediaUrl) {
                await flowDynamic(answer, { media: mediaUrl })
            } else {
                await flowDynamic(answer)
            }
        } else {
            // 🤖 Si no hay coincidencias, responde la IA
            console.log('🤖 No se encontró palabra clave, derivando a la IA...')
            const aiResponse = await groqService.getResponse(userInput, phoneNumber)
            await flowDynamic(aiResponse)
        }
    })

const main = async () => {
    await googleSheetService.getFlows()
    await googleSheetService.getPrompts()
    await googleSheetService.getScheduledMessages()
    
    setInterval(async () => {
        console.log('🧹 Iniciando limpieza automática del historial...')
        const deletedCount = await chatHistoryService.cleanOldHistories()
        console.log(`🧹 Limpieza completada. Archivos eliminados: ${deletedCount}`)
    }, 24 * 60 * 60 * 1000)
    
    const stats = await chatHistoryService.getStats()
    console.log('📊 Estadísticas del historial:', stats)
    
    const scheduledStats = await scheduledMessageService.getStats()
    console.log('📅 Estadísticas de mensajes programados:', scheduledStats)

    const adapterFlow = createFlow([dynamicFlow])
    const adapterProvider = createProvider(Provider,{version: [2, 3000, 1025190524]})
    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })
    
    // Inicializar servicio de mensajes programados
    scheduledMessageService.initialize(adapterProvider)

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    adapterProvider.server.get(
        '/v1/scheduled-stats',
        handleCtx(async (bot, req, res) => {
            const stats = await scheduledMessageService.getStats()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', stats }))
        })
    )

    adapterProvider.server.post(
        '/v1/scheduled-check',
        handleCtx(async (bot, req, res) => {
            await scheduledMessageService.forceCheck()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', message: 'Verificación forzada completada' }))
        })
    )

    adapterProvider.server.post(
        '/v1/scheduled-restart',
        handleCtx(async (bot, req, res) => {
            scheduledMessageService.restart()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', message: 'Servicio reiniciado' }))
        })
    )

    httpServer(+PORT)
}

main()
