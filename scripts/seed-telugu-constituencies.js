/**
 * Seed assembly constituencies for Telugu states (AP: 175, Telangana: 119).
 *
 * - parentName = district name AS IT EXISTS in the Location collection
 *   (Machilipatnam entry stands in for Krishna district, Ongole for Prakasam).
 * - Location.name is unique. If a constituency name clashes with an existing
 *   location (e.g. "Siddipet" district vs "Siddipet" AC), the constituency is
 *   stored as "<Name> Constituency" / "<తెలుగు> నియోజకవర్గం".
 * - Safe to re-run: existing constituency docs are skipped.
 *
 * Run: node scripts/seed-telugu-constituencies.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('../models/Location');

// [englishName, teluguName] — grouped per DB district name
const AP = {
  'Srikakulam': [
    ['Ichchapuram', 'ఇచ్ఛాపురం'], ['Palasa', 'పలాస'], ['Tekkali', 'టెక్కలి'],
    ['Pathapatnam', 'పాతపట్నం'], ['Srikakulam', 'శ్రీకాకుళం'], ['Amadalavalasa', 'ఆమదాలవలస'],
    ['Etcherla', 'ఎచ్చెర్ల'], ['Narasannapeta', 'నరసన్నపేట']
  ],
  'Parvathipuram Manyam': [
    ['Palakonda', 'పాలకొండ'], ['Kurupam', 'కురుపాం'], ['Parvathipuram', 'పార్వతీపురం'], ['Salur', 'సాలూరు']
  ],
  'Vizianagaram': [
    ['Rajam', 'రాజాం'], ['Bobbili', 'బొబ్బిలి'], ['Cheepurupalli', 'చీపురుపల్లి'],
    ['Gajapathinagaram', 'గజపతినగరం'], ['Nellimarla', 'నెల్లిమర్ల'], ['Vizianagaram', 'విజయనగరం'],
    ['Srungavarapukota', 'శృంగవరపుకోట']
  ],
  'Visakhapatnam': [
    ['Bheemili', 'భీమిలి'], ['Visakhapatnam East', 'విశాఖపట్నం తూర్పు'], ['Visakhapatnam South', 'విశాఖపట్నం దక్షిణ'],
    ['Visakhapatnam North', 'విశాఖపట్నం ఉత్తర'], ['Visakhapatnam West', 'విశాఖపట్నం పశ్చిమ'], ['Gajuwaka', 'గాజువాక']
  ],
  'Anakapalli': [
    ['Chodavaram', 'చోడవరం'], ['Madugula', 'మాడుగుల'], ['Anakapalle', 'అనకాపల్లె'],
    ['Pendurthi', 'పెందుర్తి'], ['Elamanchili', 'ఏలమంచిలి'], ['Payakaraopet', 'పాయకరావుపేట'],
    ['Narsipatnam', 'నర్సీపట్నం']
  ],
  'Alluri Sitharama Raju': [
    ['Araku Valley', 'అరకు లోయ'], ['Paderu', 'పాడేరు'], ['Rampachodavaram', 'రంపచోడవరం']
  ],
  'Kakinada': [
    ['Tuni', 'తుని'], ['Prathipadu (Kakinada)', 'ప్రత్తిపాడు (కాకినాడ)'], ['Pithapuram', 'పిఠాపురం'],
    ['Kakinada Rural', 'కాకినాడ రూరల్'], ['Peddapuram', 'పెద్దాపురం'], ['Kakinada City', 'కాకినాడ సిటీ'],
    ['Jaggampeta', 'జగ్గంపేట']
  ],
  'Konaseema': [
    ['Ramachandrapuram', 'రామచంద్రపురం'], ['Mummidivaram', 'ముమ్మిడివరం'], ['Amalapuram', 'అమలాపురం'],
    ['Razole', 'రాజోలు'], ['Gannavaram (Konaseema)', 'గన్నవరం (కోనసీమ)'], ['Kothapeta', 'కొత్తపేట'],
    ['Mandapeta', 'మండపేట']
  ],
  'East Godavari': [
    ['Anaparthy', 'అనపర్తి'], ['Rajanagaram', 'రాజానగరం'], ['Rajahmundry City', 'రాజమహేంద్రవరం సిటీ'],
    ['Rajahmundry Rural', 'రాజమహేంద్రవరం రూరల్'], ['Kovvur', 'కొవ్వూరు'], ['Nidadavole', 'నిడదవోలు'],
    ['Gopalapuram', 'గోపాలపురం']
  ],
  'West Godavari': [
    ['Achanta', 'ఆచంట'], ['Palakollu', 'పాలకొల్లు'], ['Narasapuram', 'నరసాపురం'],
    ['Bhimavaram', 'భీమవరం'], ['Undi', 'ఉండి'], ['Tanuku', 'తణుకు'], ['Tadepalligudem', 'తాడేపల్లిగూడెం']
  ],
  'Eluru': [
    ['Unguturu', 'ఉంగుటూరు'], ['Denduluru', 'దెందులూరు'], ['Eluru', 'ఏలూరు'],
    ['Polavaram', 'పోలవరం'], ['Chintalapudi', 'చింతలపూడి'], ['Nuzvid', 'నూజివీడు'], ['Kaikalur', 'కైకలూరు']
  ],
  'Krishna': [
    ['Gannavaram (Krishna)', 'గన్నవరం (కృష్ణా)'], ['Gudivada', 'గుడివాడ'], ['Pedana', 'పెడన'],
    ['Machilipatnam', 'మచిలీపట్నం'], ['Avanigadda', 'అవనిగడ్డ'], ['Pamarru', 'పామర్రు'],
    ['Penamaluru', 'పెనమలూరు']
  ],
  'NTR': [
    ['Tiruvuru', 'తిరువూరు'], ['Vijayawada West', 'విజయవాడ పశ్చిమ'], ['Vijayawada Central', 'విజయవాడ సెంట్రల్'],
    ['Vijayawada East', 'విజయవాడ తూర్పు'], ['Mylavaram', 'మైలవరం'], ['Nandigama', 'నందిగామ'],
    ['Jaggayyapeta', 'జగ్గయ్యపేట']
  ],
  'Guntur': [
    ['Tadikonda', 'తాడికొండ'], ['Mangalagiri', 'మంగళగిరి'], ['Ponnuru', 'పొన్నూరు'],
    ['Tenali', 'తెనాలి'], ['Guntur West', 'గుంటూరు పశ్చిమ'], ['Guntur East', 'గుంటూరు తూర్పు'],
    ['Prathipadu (Guntur)', 'ప్రత్తిపాడు (గుంటూరు)']
  ],
  'Palnadu': [
    ['Pedakurapadu', 'పెదకూరపాడు'], ['Chilakaluripet', 'చిలకలూరిపేట'], ['Narasaraopet', 'నరసరావుపేట'],
    ['Sattenapalle', 'సత్తెనపల్లి'], ['Vinukonda', 'వినుకొండ'], ['Gurajala', 'గురజాల'], ['Macherla', 'మాచర్ల']
  ],
  'Bapatla': [
    ['Vemuru', 'వేమూరు'], ['Repalle', 'రేపల్లె'], ['Bapatla', 'బాపట్ల'],
    ['Parchur', 'పర్చూరు'], ['Addanki', 'అద్దంకి'], ['Chirala', 'చీరాల']
  ],
  'Prakasam': [
    ['Yerragondapalem', 'ఎర్రగొండపాలెం'], ['Darsi', 'దర్శి'], ['Ongole', 'ఒంగోలు'],
    ['Kondapi', 'కొండపి'], ['Santhanuthalapadu', 'సంతనూతలపాడు'], ['Markapur', 'మార్కాపురం'],
    ['Giddalur', 'గిద్దలూరు'], ['Kanigiri', 'కనిగిరి']
  ],
  'Nellore': [
    ['Kandukur', 'కందుకూరు'], ['Kavali', 'కావలి'], ['Atmakur', 'ఆత్మకూరు'],
    ['Kovur', 'కోవూరు'], ['Nellore City', 'నెల్లూరు సిటీ'], ['Nellore Rural', 'నెల్లూరు రూరల్'],
    ['Sarvepalli', 'సర్వేపల్లి'], ['Udayagiri', 'ఉదయగిరి']
  ],
  'Tirupati': [
    ['Gudur', 'గూడూరు'], ['Sullurpeta', 'సూళ్లూరుపేట'], ['Venkatagiri', 'వెంకటగిరి'],
    ['Tirupati', 'తిరుపతి'], ['Srikalahasti', 'శ్రీకాళహస్తి'], ['Satyavedu', 'సత్యవేడు'],
    ['Chandragiri', 'చంద్రగిరి']
  ],
  'Chittoor': [
    ['Nagari', 'నగరి'], ['Gangadhara Nellore', 'గంగాధర నెల్లూరు'], ['Chittoor', 'చిత్తూరు'],
    ['Puthalapattu', 'పూతలపట్టు'], ['Palamaner', 'పలమనేరు'], ['Kuppam', 'కుప్పం'], ['Punganur', 'పుంగనూరు']
  ],
  'Annamayya': [
    ['Rajampet', 'రాజంపేట'], ['Kodur', 'కోడూరు'], ['Rayachoti', 'రాయచోటి'],
    ['Thamballapalle', 'తంబళ్లపల్లె'], ['Pileru', 'పీలేరు'], ['Madanapalle', 'మదనపల్లె']
  ],
  'Kadapa': [
    ['Badvel', 'బద్వేలు'], ['Kadapa', 'కడప'], ['Pulivendla', 'పులివెందుల'],
    ['Kamalapuram', 'కమలాపురం'], ['Jammalamadugu', 'జమ్మలమడుగు'], ['Proddatur', 'ప్రొద్దుటూరు'],
    ['Mydukur', 'మైదుకూరు']
  ],
  'Nandyal': [
    ['Allagadda', 'ఆళ్లగడ్డ'], ['Srisailam', 'శ్రీశైలం'], ['Nandikotkur', 'నందికొట్కూరు'],
    ['Nandyal', 'నంద్యాల'], ['Banaganapalle', 'బనగానపల్లె'], ['Dhone', 'డోన్'], ['Panyam', 'పాణ్యం']
  ],
  'Kurnool': [
    ['Kurnool', 'కర్నూలు'], ['Pattikonda', 'పత్తికొండ'], ['Kodumur', 'కోడుమూరు'],
    ['Yemmiganur', 'ఎమ్మిగనూరు'], ['Mantralayam', 'మంత్రాలయం'], ['Adoni', 'ఆదోని'], ['Alur', 'ఆలూరు']
  ],
  'Anantapur': [
    ['Rayadurg', 'రాయదుర్గం'], ['Uravakonda', 'ఉరవకొండ'], ['Guntakal', 'గుంతకల్లు'],
    ['Tadpatri', 'తాడిపత్రి'], ['Singanamala', 'సింగనమల'], ['Anantapur Urban', 'అనంతపురం అర్బన్'],
    ['Kalyandurg', 'కళ్యాణదుర్గం'], ['Raptadu', 'రాప్తాడు']
  ],
  'Sri Sathya Sai': [
    ['Madakasira', 'మడకశిర'], ['Hindupur', 'హిందూపురం'], ['Penukonda', 'పెనుకొండ'],
    ['Puttaparthi', 'పుట్టపర్తి'], ['Dharmavaram', 'ధర్మవరం'], ['Kadiri', 'కదిరి']
  ]
};

const TG = {
  'Kumuram Bheem Asifabad': [
    ['Sirpur', 'సిర్పూర్'], ['Asifabad', 'ఆసిఫాబాద్']
  ],
  'Mancherial': [
    ['Chennur', 'చెన్నూరు'], ['Bellampalli', 'బెల్లంపల్లి'], ['Mancherial', 'మంచిర్యాల']
  ],
  'Adilabad': [
    ['Adilabad', 'ఆదిలాబాద్'], ['Boath', 'బోథ్']
  ],
  'Nirmal': [
    ['Khanapur', 'ఖానాపూర్'], ['Nirmal', 'నిర్మల్'], ['Mudhole', 'ముధోల్']
  ],
  'Nizamabad': [
    ['Armur', 'ఆర్మూర్'], ['Bodhan', 'బోధన్'], ['Nizamabad Urban', 'నిజామాబాద్ అర్బన్'],
    ['Nizamabad Rural', 'నిజామాబాద్ రూరల్'], ['Balkonda', 'బాల్కొండ']
  ],
  'Kamareddy': [
    ['Jukkal', 'జుక్కల్'], ['Banswada', 'బాన్సువాడ'], ['Yellareddy', 'ఎల్లారెడ్డి'], ['Kamareddy', 'కామారెడ్డి']
  ],
  'Jagtial': [
    ['Korutla', 'కోరుట్ల'], ['Jagtial', 'జగిత్యాల'], ['Dharmapuri', 'ధర్మపురి']
  ],
  'Peddapalli': [
    ['Ramagundam', 'రామగుండం'], ['Manthani', 'మంథని'], ['Peddapalle', 'పెద్దపల్లె']
  ],
  'Karimnagar': [
    ['Karimnagar', 'కరీంనగర్'], ['Choppadandi', 'చొప్పదండి'], ['Manakondur', 'మానకొండూరు'],
    ['Huzurabad', 'హుజూరాబాద్']
  ],
  'Rajanna Sircilla': [
    ['Vemulawada', 'వేములవాడ'], ['Sircilla', 'సిరిసిల్ల']
  ],
  'Siddipet': [
    ['Husnabad', 'హుస్నాబాద్'], ['Siddipet', 'సిద్దిపేట'], ['Dubbak', 'దుబ్బాక'], ['Gajwel', 'గజ్వేల్']
  ],
  'Medak': [
    ['Medak', 'మెదక్'], ['Narsapur', 'నర్సాపూర్']
  ],
  'Sangareddy': [
    ['Narayankhed', 'నారాయణఖేడ్'], ['Andole', 'అందోల్'], ['Zahirabad', 'జహీరాబాద్'],
    ['Sangareddy', 'సంగారెడ్డి'], ['Patancheru', 'పటాన్‌చెరు']
  ],
  'Medchal-Malkajgiri': [
    ['Medchal', 'మేడ్చల్'], ['Malkajgiri', 'మల్కాజ్‌గిరి'], ['Quthbullapur', 'కుత్బుల్లాపూర్'],
    ['Kukatpally', 'కూకట్‌పల్లి'], ['Uppal', 'ఉప్పల్']
  ],
  'Rangareddy': [
    ['Ibrahimpatnam', 'ఇబ్రహీంపట్నం'], ['Lal Bahadur Nagar', 'ఎల్‌బీ నగర్'], ['Maheshwaram', 'మహేశ్వరం'],
    ['Rajendranagar', 'రాజేంద్రనగర్'], ['Serilingampally', 'శేరిలింగంపల్లి'], ['Chevella', 'చేవెళ్ల'],
    ['Shadnagar', 'షాద్‌నగర్']
  ],
  'Vikarabad': [
    ['Pargi', 'పరిగి'], ['Vikarabad', 'వికారాబాద్'], ['Tandur', 'తాండూరు'], ['Kodangal', 'కొడంగల్']
  ],
  'Hyderabad': [
    ['Musheerabad', 'ముషీరాబాద్'], ['Malakpet', 'మలక్‌పేట'], ['Amberpet', 'అంబర్‌పేట'],
    ['Khairatabad', 'ఖైరతాబాద్'], ['Jubilee Hills', 'జూబ్లీహిల్స్'], ['Sanathnagar', 'సనత్‌నగర్'],
    ['Nampally', 'నాంపల్లి'], ['Karwan', 'కార్వాన్'], ['Goshamahal', 'గోషామహల్'],
    ['Charminar', 'చార్మినార్'], ['Chandrayangutta', 'చాంద్రాయణగుట్ట'], ['Yakutpura', 'యాకుత్‌పురా'],
    ['Bahadurpura', 'బహదూర్‌పురా'], ['Secunderabad', 'సికింద్రాబాద్'],
    ['Secunderabad Cantonment', 'సికింద్రాబాద్ కంటోన్మెంట్']
  ],
  'Narayanpet': [
    ['Narayanpet', 'నారాయణపేట'], ['Makthal', 'మక్తల్']
  ],
  'Mahbubnagar': [
    ['Mahbubnagar', 'మహబూబ్‌నగర్'], ['Jadcherla', 'జడ్చర్ల'], ['Devarkadra', 'దేవరకద్ర']
  ],
  'Wanaparthy': [
    ['Wanaparthy', 'వనపర్తి']
  ],
  'Jogulamba Gadwal': [
    ['Gadwal', 'గద్వాల్'], ['Alampur', 'అలంపూర్']
  ],
  'Nagarkurnool': [
    ['Nagarkurnool', 'నాగర్‌కర్నూల్'], ['Achampet', 'అచ్చంపేట'], ['Kalwakurthy', 'కల్వకుర్తి'],
    ['Kollapur', 'కొల్లాపూర్']
  ],
  'Nalgonda': [
    ['Devarakonda', 'దేవరకొండ'], ['Nagarjuna Sagar', 'నాగార్జునసాగర్'], ['Miryalaguda', 'మిర్యాలగూడ'],
    ['Nalgonda', 'నల్గొండ'], ['Munugode', 'మునుగోడు'], ['Nakrekal', 'నకిరేకల్']
  ],
  'Suryapet': [
    ['Huzurnagar', 'హుజూర్‌నగర్'], ['Kodad', 'కోదాడ'], ['Suryapet', 'సూర్యాపేట'],
    ['Thungathurthi', 'తుంగతుర్తి']
  ],
  'Yadadri Bhuvanagiri': [
    ['Bhongir', 'భువనగిరి'], ['Alair', 'ఆలేరు']
  ],
  'Jangaon': [
    ['Jangaon', 'జనగామ'], ['Ghanpur (Station)', 'స్టేషన్ ఘన్‌పూర్'], ['Palakurthi', 'పాలకుర్తి']
  ],
  'Mahabubabad': [
    ['Dornakal', 'డోర్నకల్'], ['Mahabubabad', 'మహబూబాబాద్']
  ],
  'Warangal': [
    ['Narsampet', 'నర్సంపేట'], ['Wardhanapet', 'వర్ధన్నపేట']
  ],
  'Hanumakonda': [
    ['Warangal West', 'వరంగల్ పశ్చిమ'], ['Warangal East', 'వరంగల్ తూర్పు'], ['Parkal', 'పరకాల']
  ],
  'Jayashankar Bhupalpally': [
    ['Bhupalpalle', 'భూపాలపల్లి']
  ],
  'Mulugu': [
    ['Mulug', 'ములుగు']
  ],
  'Bhadradri Kothagudem': [
    ['Pinapaka', 'పినపాక'], ['Yellandu', 'ఇల్లందు'], ['Kothagudem', 'కొత్తగూడెం'],
    ['Aswaraopeta', 'అశ్వారావుపేట'], ['Bhadrachalam', 'భద్రాచలం']
  ],
  'Khammam': [
    ['Khammam', 'ఖమ్మం'], ['Palair', 'పాలేరు'], ['Madhira', 'మధిర'],
    ['Wyra', 'వైరా'], ['Sathupalle', 'సత్తుపల్లి']
  ]
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/shortnews');
  console.log('Connected to MongoDB');

  // Jangaon district DB lo ledu — add it first (official 33rd TG district)
  const jangaon = await Location.findOne({ name: 'Jangaon', locationType: 'district' });
  if (!jangaon) {
    const clash = await Location.findOne({ name: 'Jangaon' });
    if (!clash) {
      await Location.create({
        name: 'Jangaon', teluguName: 'జనగామ', code: 'JGN',
        locationType: 'district', parentName: 'Telangana',
        languages: ['te', 'en'], isActive: true
      });
      console.log('+ District added: Jangaon (Telangana)');
    }
  }

  const existingNames = new Set((await Location.find({}).select('name').lean()).map((l) => l.name));
  const existingCodes = new Set((await Location.find({}).select('code').lean()).map((l) => l.code));

  const stats = { added: 0, skipped: 0, renamed: 0, missingDistricts: [] };
  let seq = { AP: 0, TG: 0 };

  async function seedState(data, prefix) {
    for (const [districtName, acs] of Object.entries(data)) {
      const district = await Location.findOne({ name: districtName, locationType: 'district' });
      if (!district) {
        stats.missingDistricts.push(districtName);
        continue;
      }
      for (const [enName, teName] of acs) {
        seq[prefix] += 1;
        let code = `${prefix}-AC-${seq[prefix]}`;
        while (existingCodes.has(code)) code = code + 'X';

        let name = enName;
        let telugu = teName;
        if (existingNames.has(name)) {
          // Same-name district/city already unnadi — suffix tho unique cheyadam
          const already = await Location.findOne({ name, locationType: 'constituency', parentName: districtName });
          if (already) { stats.skipped++; continue; }
          name = `${enName} Constituency`;
          telugu = `${teName} నియోజకవర్గం`;
          stats.renamed++;
          if (existingNames.has(name)) { stats.skipped++; continue; }
        }

        await Location.create({
          name,
          teluguName: telugu,
          localName: telugu,
          code,
          locationType: 'constituency',
          parentName: districtName,
          languages: ['te', 'en'],
          isActive: true
        });
        existingNames.add(name);
        existingCodes.add(code);
        stats.added++;
      }
    }
  }

  await seedState(AP, 'AP');
  await seedState(TG, 'TG');

  console.log('\n===== SUMMARY =====');
  console.log('Added:', stats.added, '| Skipped (already unnayi):', stats.skipped, '| Renamed (name clash):', stats.renamed);
  if (stats.missingDistricts.length) {
    console.log('DB lo dorakani districts (skip ayyayi):', stats.missingDistricts.join(', '));
  }

  const apCount = await Location.countDocuments({ locationType: 'constituency', parentName: { $in: Object.keys(AP) } });
  const tgCount = await Location.countDocuments({ locationType: 'constituency', parentName: { $in: Object.keys(TG) } });
  console.log(`AP constituencies in DB: ${apCount} (expected 175)`);
  console.log(`TG constituencies in DB: ${tgCount} (expected 119)`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
