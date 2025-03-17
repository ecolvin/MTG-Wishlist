import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

const SCRYFALL_URL = "https://api.scryfall.com/";
const SEARCH_ENDPOINT = "/cards/search";
const SETS_ENDPOINT = "/sets";
const WAIT_TIME = 50;
const SET_JSON_NAME = "sealed_basic_data.json";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));

let wishList = new Set(); //Set with all previously provided card names
let setData = []; //Array of MTG sets and their info
let setArray = []; //Array of sets to be passed to ejs files as data
let cardsByName = {}; //Map of queried cards, indexed by card name (can have multiple variants per name)
let cardsBySet = {}; //Map of queried cards, indexed by set code
let boosterPackDetails;


function getNumUniqueCardNames(cardList) 
{
    let cardSet = new Set();
    for(const card of cardList)
    {
        cardSet.add(card.name);
    }
    return cardSet.size;
}

function getRarityCounts(cardList)
{
    let rarities = {
        common: 0,
        uncommon: 0,
        rare: 0,
        mythic: 0,
        other: 0
    };

    let cardSet = new Set();

    for(const card of cardList)
    {
        if(cardSet.has(card.name))
        {
            continue;
        }
        cardSet.add(card.name);

        switch(card?.rarity)
        {
            case "common":
                rarities.common++;
                break;
            case "uncommon":
                rarities.uncommon++;
                break;
            case "rare":
                rarities.rare++;
                break;
            case "mythic":
                rarities.mythic++;
                break;
            default:
                rarities.other++;
                break;
        }
    }
    return rarities;
}

function getCardOdds(cardData, boosters, totalWeight)
{
    let cumulativeOdds = 0;
    for(const booster of boosters)
    {
        let inverseBoosterOdds = 1;
        for(const sheet of cardData.sheets)
        {
            if(sheet.sheetName in booster.sheets)
            {
                inverseBoosterOdds *= Math.pow(1 - (sheet.odds/100), booster.sheets[sheet.sheetName]);
            }
        }
        cumulativeOdds += (1 - inverseBoosterOdds) * (booster.weight/totalWeight);
    }
    return cumulativeOdds * 100;
}

function getPackDetails(setCode)
{
    //Get the JSON data for all the different pack types with the requested set code
    const packs = boosterPackDetails.filter(pack => pack.set_code === setCode);

    //Loop through each different pack type from this set to create a new pack object with the necessary data
    let newPacks = [];
    for(const pack of packs)
    {
        //Skip Arena Sets (This app is for paper only) Also temporarily excluding promo packs and sample packs
        if(pack.name.includes("Arena") || 
           pack.name.includes("Promo") || 
           pack.name.includes("Tournament") ||
           pack.name.includes("Topper") ||
           pack.name.includes("Sample"))
        {
            continue;
        }

        //Create the array of cards with a matching set code
        let possibleCards = [];        
        for(const code of pack.source_set_codes)
        {
            possibleCards = possibleCards.concat(cardsBySet[code]);
        }

        //Create updated sheets objects that only contain the cards on the wishlist and their weights
        let sheets = {}; 
        //Create a card map indexed by a card object containing an array of objects containing the sheet name and the card's odds in that sheet
        let cards = new Map();
        for(const [sheetName, sheetData] of Object.entries(pack.sheets))
        { 
            //New Sheet object that includes the total weight of wishlist cards as well as the full card data for each card in the sheet
            let newSheetObject = {
                totalWeight: sheetData.total_weight,
                totalTargetWeight: 0,
                cards: [],
            };

            //If sheet is fixed (always has the same cards), set totalWeight to 1
            if("fixed"in sheetData)
            {
                newSheetObject.totalWeight = 1; 
            }

            //Loop through each possible card to see if it's on the sheet (check both foil and non-foil versions)
            for(const card of possibleCards)
            {
                if(!card)
                {
                    continue;
                }
                //Check for the non-foil card
                let cardCode = card.set + ":" + card.collector_number; 
                if("card_faces" in card)
                {
                    cardCode += "a";
                }
                if(cardCode in sheetData.cards)
                {
                    const weight = sheetData.cards[cardCode];
                    
                    const cardSheetData = {
                        sheetName: sheetName,
                        foil: false,
                        odds: (weight / sheetData.total_weight) * 100,
                    };
                    
                    if(cards.has(card))
                    {
                        cards.get(card).sheets.push(cardSheetData);
                    }
                    else
                    {
                        cards.set(card, {totalOdds: 0, sheets: [cardSheetData]});
                    }
                    

                    newSheetObject.cards.push({
                        card: card,
                        weight: weight,
                        foil: false,
                    });
                    newSheetObject.totalTargetWeight += weight;
                }
                   
                //Check for the foil card
                const cardCodeFoil = cardCode + ":foil";
                if(cardCodeFoil in sheetData.cards)
                {
                    const weight = sheetData.cards[cardCodeFoil];
                    
                    const cardSheetData = {
                        sheetName: sheetName,
                        foil: true,
                        odds: (weight / sheetData.total_weight) * 100,
                    };
                    
                    if(cards.has(card))
                    {
                        cards.get(card).sheets.push(cardSheetData);
                    }
                    else
                    {
                        cards.set(card, {totalOdds: 0, sheets: [cardSheetData]});
                    }

                    newSheetObject.cards.push({
                        card: card,
                        weight: sheetData.cards[cardCodeFoil],
                        foil: true,
                    });
                    newSheetObject.totalTargetWeight += weight;
                }         
            }

            sheets[sheetName] = newSheetObject;
        }

        //Calculate the total weight of the different booster configurations (needed for odds calculation later)
        let totalWeight = 0;
        pack.boosters.forEach(booster => {
            totalWeight += booster.weight;
        });

        //Loop through each different booster configuration to calculate the odds of getting a card from 
        //the wishlist in that specific config, as well as the total odds to get a wishlist card from this type of pack
        let boosters = [];
        let totalPackOdds = 0;
        for(const booster of pack.boosters)
        {
            let inverseBoosterOdds = 1;

            for(const [sheetName, numRolls] of Object.entries(booster.sheets))
            {   
                const sheet = sheets[sheetName];
                let cumulativeInverseOdds = 0;

                if(sheet.totalWeight !== 1)
                {
                    const sheetOdds = sheet.totalTargetWeight / sheet.totalWeight;
                    cumulativeInverseOdds = Math.pow(1-sheetOdds, numRolls); 
                }
                inverseBoosterOdds *= cumulativeInverseOdds;
            }

            const odds = 1 - inverseBoosterOdds;
            
            totalPackOdds += odds * (booster.weight/totalWeight);

            //New Booster object that includes the odds to get a wishlist card
            boosters.push({
                sheets: booster.sheets,
                weight: booster.weight,
                odds: odds,
            });
        }

        for(const data of cards.values())
        {
            data.totalOdds = getCardOdds(data, boosters, totalWeight);
        }

        cards = new Map([...cards].sort((a, b) => {
            return b[1].totalOdds - a[1].totalOdds;
        }));

        //Add the updated pack object to the array of packs for this set
        const packName = pack.name.replace(pack.set_name + " ", "");
        newPacks.push({
            name: pack.name,
            code: pack.code,
            setCode: pack.set_code,
            setName: pack.set_name,
            packName: packName,
            boosters: boosters,
            sheets: sheets,
            odds: totalPackOdds,
            cards: cards,
        });
    }
    return newPacks;
}

function getSetArray() 
{
    let sets = [];

    for(const [setCode, setCards] of Object.entries(cardsBySet))
    {
        let set = setData.find(set => set.code === setCode);
        let setObject = {
            code: setCode,
            icon: set?.icon_svg_uri ?? "",
            name: set?.name ?? "Undefined Name",
            size: getNumUniqueCardNames(setCards),
            cards: setCards,
            rarities: getRarityCounts(setCards),
            packs: getPackDetails(setCode),
        };
        sets.push(setObject);
    }

    sets.sort((a, b) => {
        return b.size - a.size;
    });

    return sets;
}

function generateScryfallQueries(nameList) 
{
    let queries = [];
    let query = "";
    
    let cardSet = new Set();

    for(let cardName of nameList)
    {
        cardName = cardName.trim();
        if(cardName === "" || cardName in cardsByName || cardSet.has(cardName))
        {
            continue;
        }
        if(query.length + cardName.length + 5 < 1000)
        {        
            query += "!\"" + cardName + "\"or";
        }
        else
        {
            queries.push(query);
            query = "!\"" + cardName + "\"or";
        }

        cardSet.add(cardName);
    }

    queries.push(query);
    return queries;
}

function processCardArray(cardArray) 
{
    for(const card of cardArray)
    {
        if(card?.games?.includes('paper'))
        {
            const cardName = card.name;
            const setCode = card.set;
    
            wishList.add(cardName);

            cardsByName[cardName] = cardsByName[cardName] || [];
            cardsByName[cardName].push(card);

            cardsBySet[setCode] = cardsBySet[setCode] || [];
            cardsBySet[setCode].push(card);
        }
    }
    setArray = getSetArray();
}

/*
-----------------------------------------------------
--------------End Function Declaration---------------
-----------------------------------------------------
*/

try 
{
    const filePath = path.join(__dirname, SET_JSON_NAME);
    const data = await fs.readFile(filePath, "utf8");
    boosterPackDetails = JSON.parse(data);
    console.log("Set JSON loaded successfully");        
} 
catch (error) 
{
    console.error("Error Loading JSON file:", error);
    process.exit(1);
}

try 
{
    const response = await axios.get(SCRYFALL_URL + SETS_ENDPOINT, {headers: { Accept: "*/*",},});
    setData = response.data.data;
    await delay(WAIT_TIME);
    console.log("Set Data retrieved from Scryfall");
} 
catch (error) 
{
    console.error("Error fetching set data from Scryfall:", error);
    process.exit(1);
}

app.get("/", (req, res) => {
    res.render("index.ejs", {wishList: Array.from(wishList)});
});

app.get("/sets", (req, res) => {
    res.render("sets.ejs", {sets: setArray});
});

app.get("/decks", (req, res) => {
    //update to pass correct details
    //Show different pre-made decks and data related to them
    res.render("decks.ejs", {sets: setArray});
});

app.get("/setDetails/:setCode", (req, res) => {
    const setCode = req.params.setCode; 
    res.render("setDetails.ejs", {setData: cardsBySet[setCode]});
});

app.get("/packDetails/:setCode", (req, res) => {
    const setCode = req.params.setCode; 
    const set = setArray.find(set => set.code === setCode);
    res.render("packDetails.ejs", {setData: set});
});

app.get("/deckDetails/:deckCode", (req, res) => {
    const deckCode = req.params.deckCode; 
    res.render("setDetails.ejs", {setData: cardsBySet[deckCode]});
});

app.post("/processWishlist", async (req, res) => {
    const wishListText = req.body.wishlistText.split(/\r?\n/);    

    const scryfallQueries = generateScryfallQueries(wishListText);
    let cardArray = [];
    for(const query of scryfallQueries)
    {
        console.log("Querying scryfall: " + query);
        try 
        {
            let response = await axios.get(SCRYFALL_URL + SEARCH_ENDPOINT, {
                headers: {
                    Accept: "*/*",
                },
                params: {
                    q: query,
                    unique: "prints",
                },
            });

            cardArray = cardArray.concat(response.data.data);
            await delay(WAIT_TIME);

            while (response.data.has_more)
            {
                console.log("Fetching next page...");
                response = await axios.get(response.data.next_page,{headers:{Accept: "*/*",},});
                cardArray = cardArray.concat(response.data.data);
                await delay(WAIT_TIME);
            }
        
        } 
        catch (error) 
        {
            console.error(error);            
        }
    }
    
    console.log("Processing card array... Card Array size: ", cardArray.length);
    processCardArray(cardArray);

    res.redirect("/sets");
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});



/*
TO-DOs:
-Update Set page to only show sets that have booster packs
-Check Booster data to ensure that there are no important packs with "Promo" or "Sample" in their names

-Have a separate deck page for precons that contain needed cards
-Deal with List and Secret Lair cards
-Update the wishlist page to be more dynamic
---Either import a list or add one by one (query scryfall when added)
-Show something to user when a card can't be found
-Update to query scryfall for all cards at once and then sort them by name and by set
-Allow wishlist to include quantities (not sure how that would factor into booster percentages though)
*/

/*
Test queries:

Wooded Foothills
Windswept Heath
Polluted Delta
Flooded Strand
Bloodstained Mire
*/