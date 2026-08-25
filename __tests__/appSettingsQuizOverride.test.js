const appSettingsRoutes = require('../routes/appSettingsRoutes');
const AppSettings = require('../models/AppSettings');
const { getQuizConfig } = require('../services/quizLanguageService');

jest.mock('../models/AppSettings', () => ({
    findOne: jest.fn()
}));

jest.mock('../services/quizLanguageService', () => ({
    getQuizConfig: jest.fn()
}));

jest.mock('../controllers/adminController', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

// Helper to simulate calling the route
const executeRoute = async () => {
    return new Promise((resolve) => {
        const req = {};
        const res = {
            json: (data) => resolve(data),
            status: () => res
        };
        const route = appSettingsRoutes.stack.find(layer => layer.route && layer.route.path === '/api/public/app-settings');
        const handler = route.route.stack.find(s => s.method === 'get').handle;
        handler(req, res);
    });
};

beforeEach(() => {
    AppSettings.findOne.mockResolvedValue({
        toObject: () => ({
            isQuizEnabled: false, // legacy setting
            quizEnabledLanguages: ['fr'], // legacy setting
            isSwipeStreakEnabled: true
        })
    });
});

test('Quiz enabled + Telugu enabled', async () => {
    getQuizConfig.mockResolvedValue({ isEnabled: true, langs: ['te'] });
    
    const body = await executeRoute();
    expect(body.isQuizEnabled).toBe(true);
    expect(body.quizEnabledLanguages).toEqual(['te']);
    // Ensure unrelated settings remain
    expect(body.isSwipeStreakEnabled).toBe(true);
});

test('Quiz disabled', async () => {
    getQuizConfig.mockResolvedValue({ isEnabled: false, langs: ['te'] });
    
    const body = await executeRoute();
    expect(body.isQuizEnabled).toBe(false);
    expect(body.quizEnabledLanguages).toEqual(['te']);
});

test('Telugu + English enabled', async () => {
    getQuizConfig.mockResolvedValue({ isEnabled: true, langs: ['te', 'en'] });
    
    const body = await executeRoute();
    expect(body.isQuizEnabled).toBe(true);
    expect(body.quizEnabledLanguages).toEqual(['te', 'en']);
});

test('Empty enabledLanguages -> return empty array', async () => {
    getQuizConfig.mockResolvedValue({ isEnabled: false, langs: [] });
    
    const body = await executeRoute();
    expect(body.isQuizEnabled).toBe(false);
    expect(body.quizEnabledLanguages).toEqual([]);
});

