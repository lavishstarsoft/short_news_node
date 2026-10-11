'use strict';
const { pickImage, maskPhone } = require('../controllers/nexaVerifyController');
describe('NEXA verify helpers', () => {
  test('pickImage prefers imageUrls[0], then image mediaUrl, then imageUrl, then thumbnail', () => {
    expect(pickImage({ imageUrls:['a.jpg'], mediaUrl:'m', imageUrl:'i', thumbnailUrl:'t' })).toBe('a.jpg');
    expect(pickImage({ mediaType:'image', mediaUrl:'m.png', imageUrl:'i' })).toBe('m.png');
    expect(pickImage({ imageUrl:'i.jpg' })).toBe('i.jpg');
    expect(pickImage({ thumbnailUrl:'t.jpg' })).toBe('t.jpg');
    expect(pickImage({ mediaUrl:'https://x/pic.webp' })).toBe('https://x/pic.webp');
    expect(pickImage({ mediaType:'video', mediaUrl:'v.mp4' })).toBeNull();
    expect(pickImage({})).toBeNull();
    expect(pickImage(null)).toBeNull();
  });
  test('maskPhone keeps only last 4 digits', () => {
    expect(maskPhone('9876543210')).toBe('******3210');
    expect(maskPhone('+91 98765 43210')).toBe('********3210');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('12')).toBe('****');
  });
});
