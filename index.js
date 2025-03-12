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

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

let wishList = new Set(); //Set with all previously provided card names
let setData = []; //Array of MTG sets and their info
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
    res.render("sets.ejs", {sets: getSetArray()});
});

app.get("/packs", (req, res) => {
    //Update to pass correct details
    //Show different booster packs and data related to them
    res.render("packs.ejs", {sets: getSetArray()});
});

app.get("/decks", (req, res) => {
    //update to pass correct details
    //Show different pre-made decks and data related to them
    res.render("decks.ejs", {sets: getSetArray()});
});

app.get("/setDetails/:setCode", (req, res) => {
    const setCode = req.params.setCode; 
    res.render("setDetails.ejs", {setData: cardsBySet[setCode]});
});

app.get("/packDetails/:setCode", (req, res) => {
    const setCode = req.params.setCode; 
    res.render("setDetails.ejs", {setData: cardsBySet[setCode]});
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
-Figure out different booster types and calculate percent chance of getting a wishlist card per booster
-Have a separate deck page for precons that contain needed cards
-Deal with List and Secret Lair cards
-Update the wishlist page to be more dynamic
---Either import a list or add one by one (query scryfall when added)
-Show something to user when a card can't be found
-Update to query scryfall for all cards at once and then sort them by name and by set
-Allow wishlist to include quantities (not sure how that would factor into booster percentages though)
*/


/*
Pack Display conceptualization:

/packs
Cards sorted by Set
-Display Set Icon
-Display different pack options and their percentages
-Have total Number of cards in the bottom right (don't include cards that can't be in the booster packs)
-Have details button in the bottom left

/packDetails
On Pack page
-Have H2 with different booster names
-Show the possible sheet distributions for each booster pack
-Show all possible cards that can be in each slot with their odds (carousel?)
*/