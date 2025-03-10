import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
const port = 3000;
const SCRYFALL_URL = "https://api.scryfall.com/";
const SEARCH_ENDPOINT = "/cards/search";
const WAIT_TIME = 50;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

let wishList = [];
let cardData = {};
let setData = {};

app.get("/", (req, res) => {
    res.render("index.ejs", {wishList: wishList});
});

app.get("/sets", (req, res) => {

    let sets = new Array();

    for(const [setCode, setInfo] of Object.entries(setData))
    {
        let setObject = {
            code: setCode,
            name: setInfo.setName,
            size: setInfo.cards.length,
            cards: setInfo.cards,
        };
        sets.push(setObject);
    }

    sets.sort((a, b) => {
        return b.size - a.size;
    });

    console.log(sets);

    res.render("sets.ejs", {sets: sets});
});

app.get("/setDetails/:setCode", (req, res) => {
    const setCode = req.params.setCode;       

    res.render("setDetails.ejs", {setData: setData[setCode]});
});

app.post("/processWishlist", async (req, res) => {
    const wishListText = req.body.wishlistText.split(/\r?\n/);    
    for(let cardName of wishListText)
    {
        cardName = cardName.trim();
        if(cardName === "" || cardName in cardData)
        {
            continue;
        }

        //Validate cardName to prevent query injection

        wishList.push(cardName);
        const scryfallQuery = "!\"" + cardName + "\"";
        
        console.log("Querying scryfall: " + scryfallQuery);
        try {
            let response;
            let cardArray = [];
               
            response = await axios.get(SCRYFALL_URL + SEARCH_ENDPOINT, {
                headers: {
                    Accept: "*/*",
                },
                params: {
                    q: scryfallQuery,
                    unique: "prints",
                },
            });
            cardArray = cardArray.concat(response.data.data);
            await delay(WAIT_TIME);
            while (response.data.has_more)
            {
                response = await axios.get(response.data.next_page,{headers:{Accept: "*/*",},});
                cardArray = cardArray.concat(response.data.data);
                await delay(WAIT_TIME);
            }
            cardData[cardName] = cardArray;

            for(const card of cardArray)
            {
                if(card.games.includes('paper'))
                {
                    const setCode = card.set;
                    const setName = card.set_name;
                    console.log(setName);
                    if(!(setCode in setData))
                    {
                        setData[setCode] = {
                            setName: setName,
                            cards: [card],
                        };
                    }
                    else
                    {    
                        setData[setCode].cards.push(card);
                    }
                }
            }

        } catch (error) {
            console.log(error);            
        }
    }

    res.redirect("/sets");
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});