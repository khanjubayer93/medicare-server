const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
const port = process.env.PORT || 5000;
const app = express();


// middleware 
app.use(cors());
app.use(express.json());
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Mongodb connected
const uri = `mongodb+srv://${process.env.MONGO_DB_USER}:${process.env.MONGO_DB_PASSWORD}@cluster0.lhwdfip.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri)

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    // console.log(authHeader);
    if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
    const token = authHeader.split(' ')[1];
    // console.log(token);
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access 1' })
        }
        req.decoded = decoded;
        next()
    })
}

function conndeDB() {
    try {
        const slotCollection = client.db('medicare').collection('slots');
        const bookingCollection = client.db('medicare').collection('bookings');
        const usersCollection = client.db('medicare').collection('users');
        const doctorCollection = client.db('medicare').collection('doctors');
        const paymentCollection = client.db('medicare').collection('payment');

        // verifyAdmin api
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);
            if (user?.role !== 'admin') {
                res.status(403).send({ message: 'forbidden access to make admin' })
            }
            next()
        }

        // jwt api
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' });
                return res.send({ accessToken: token })
            }
            res.status(403).send({ message: 'forbidden access 2' })
        });

        // payment api
        app.post('/create-payment-intent', async (req, res) => {
            const paymentData = req.body;
            const price = paymentData.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: "usd",
                amount: amount,
                "payment_method_types": [
                    "card"
                ],
            });
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        app.post('/payment', async (req, res) => {
            const payment = req.body;
            const result = await paymentCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: new ObjectId(id) };
            const updatePayment = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            };
            const updateResult = await bookingCollection.updateOne(filter, updatePayment)
            res.send(result)
        })

        // service api
        app.get('/slots', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const cursor = slotCollection.find(query);
            const slots = await cursor.toArray();
            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();
            slots.forEach(service => {
                const slotBooked = alreadyBooked.filter(booked => booked.serviceName === service.name)
                const slotBookedNow = slotBooked.map(book => book.appointmentTime)
                const remainingSlots = service.slots.filter(slot => !slotBookedNow.includes(slot));
                service.slots = remainingSlots;
                // console.log(date, service.name, remainingSlots.length);
            })
            res.send(slots)
        });

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                serviceName: booking.serviceName,
                email: booking.email
            }
            const limitedBooking = await bookingCollection.find(query).toArray();

            if (limitedBooking.length) {
                const message = `You cannot book this service on ${booking.appointmentDate}`;
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingCollection.insertOne(booking);
            res.send(result)
        });

        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (decodedEmail !== email) {
                return res.status(401).send({ message: 'forbidden access 3' })
            }
            const query = { email: email };
            const result = await bookingCollection.find(query).toArray();
            res.send(result)
        });

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await bookingCollection.findOne(query)
            res.send(result)
        });

        // users api
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        });

        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users)
        });

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' })
        });

        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {

            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateUser = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updateUser, options)
            res.send(result)
        });

        app.get('/addPrice', async (req, res) => {
            const filter = {};
            const options = { upsert: true };
            const updatePrice = {
                $set: {
                    price: 89
                }
            }
            const result = await slotCollection.updateMany(filter, updatePrice, options);
            res.send(result)
        })

        app.get('/slotSpeciality', async (req, res) => {
            const query = {};
            const speciality = await slotCollection.find(query).project({ name: 1 }).toArray();
            res.send(speciality)
        });

        // doctor api
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result)
        });

        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctor = await doctorCollection.find(query).toArray();
            res.send(doctor)
        });

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const doctor = await doctorCollection.deleteOne(query);
            res.send(doctor)
        });

    }
    finally {

    }
}
conndeDB()

app.get('/', (req, res) => {
    res.send('Medicare server is running')
});

app.listen(port, () => {
    console.log(`Medicare server is running on port ${port}`)
})